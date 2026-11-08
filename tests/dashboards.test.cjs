const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const dashboardDirectory = path.join(__dirname, '..', 'dashboards');
const dashboards = fs.readdirSync(dashboardDirectory)
  .filter(name => name.endsWith('.json'))
  .map(name => ({ name, dashboard: JSON.parse(fs.readFileSync(path.join(dashboardDirectory, name), 'utf8')) }));

function panel(filename, id) {
  return dashboards.find(entry => entry.name === filename).dashboard.panels.find(item => item.id === id);
}

function allPanels(panels) {
  return panels.flatMap(item => [item, ...allPanels(item.panels || [])]);
}

test('dashboard UIDs and panel dependencies are unique and acyclic', () => {
  const uids = new Set();
  for (const { name, dashboard } of dashboards) {
    assert.ok(dashboard.uid, name);
    assert.ok(!uids.has(dashboard.uid), `${name}: duplicate UID`);
    uids.add(dashboard.uid);
    const items = allPanels(dashboard.panels);
    const byId = new Map(items.map(item => [item.id, item]));
    assert.equal(byId.size, items.length, `${name}: duplicate panel ID`);
    function visit(id, ancestors = []) {
      assert.ok(!ancestors.includes(id), `${name}: cyclic dependency ${id}`);
      for (const target of byId.get(id).targets || []) {
        if (target.panelId === undefined) continue;
        assert.ok(byId.has(target.panelId), `${name}: missing source ${target.panelId}`);
        visit(target.panelId, [...ancestors, id]);
      }
    }
    for (const item of items) visit(item.id);
  }
});

test('all dashboard distances and minute labels use fixed units', () => {
  for (const { name, dashboard } of dashboards) {
    for (const item of allPanels(dashboard.panels)) {
      const units = [item.fieldConfig?.defaults?.unit, ...(item.fieldConfig?.overrides || [])
        .flatMap(override => override.properties || [])
        .filter(property => property.id === 'unit').map(property => property.value)];
      assert.ok(!units.some(unit => ['lengthkm', 'lengthm', 'm'].includes(unit)), `${name} panel ${item.id}: automatic unit`);
    }
    assert.doesNotMatch(JSON.stringify(dashboard), /\bmins\b/i, `${name}: plural minute suffix`);
  }
});

test('shared pie charts select only their source fields and retain their labels', () => {
  for (const [filename, id, sourceId] of [
    ['tm-energie-reelle.json', 24, 11],
    ['tms-stats-recharge.json', 15, 3],
    ['tms-stats-recharge.json', 17, 3]
  ]) {
    const pie = panel(filename, id);
    const sourceSql = panel(filename, sourceId).targets[0].rawSql;
    assert.equal(pie.datasource.uid, '-- Dashboard --');
    assert.equal(pie.targets[0].datasource.uid, '-- Dashboard --');
    assert.equal(pie.targets[0].panelId, sourceId);
    assert.equal(pie.targets[0].rawSql, undefined);
    assert.equal(pie.options.reduceOptions.values, false);
    const calculation = pie.transformations.find(item => item.id === 'calculateField');
    const generatedFields = new Set();
    if (calculation) {
      assert.equal(calculation.options.binary.operator, '-');
      for (const operand of ['left', 'right']) {
        assert.ok(sourceSql.includes(`AS "${calculation.options.binary[operand]}"`));
      }
      generatedFields.add(calculation.options.alias);
    }
    const names = pie.transformations.find(item => item.id === 'filterFieldsByName').options.include.names;
    const renamed = pie.transformations.find(item => item.id === 'organize').options.renameByName;
    for (const name of names) assert.ok(generatedFields.has(name) || sourceSql.includes(`AS "${name}"`));
    const labels = names.map(name => renamed[name] || name);
    const colorLabels = pie.fieldConfig.overrides.map(item => item.matcher.options);
    assert.deepEqual(new Set(labels), new Set(colorLabels));
  }
  const rechargeSql = panel('tms-stats-recharge.json', 3).targets[0].rawSql;
  assert.equal((rechargeSql.match(/FROM charges c/g) || []).length, 1);
  assert.match(rechargeSql, /JOIN LATERAL/);
  assert.match(rechargeSql, /COALESCE\(charge\.tesla, false\)/);
});

test('battery estimates preserve unknown health and degradation', () => {
  const sql = panel('tms-batterie.json', 3).targets[0].rawSql;
  assert.match(sql, /CASE WHEN cur\.k IS NOT NULL AND ref\.k > 0 THEN LEAST/);
  assert.match(sql, /CASE WHEN cur\.k IS NOT NULL AND ref\.k > 0 THEN GREATEST/);
  assert.equal((sql.match(/\$\{kwh_neuf:sqlstring\}/g) || []).length, 1);
});

test('climate intervals include driving and streaming observations without inventing a final duration', () => {
  const sql = panel('tms-temperatures.json', 11).targets[0].rawSql;
  assert.match(sql, /lead\(date\).*AS next_date/);
  assert.doesNotMatch(sql.split('intervals AS')[0], /drive_id IS NULL/);
  assert.doesNotMatch(sql, /battery_range/);
  assert.match(sql, /CASE WHEN next_date IS NOT NULL THEN LEAST/);
  assert.match(sql, /FROM s WHERE drive_id IS NULL/);
});

test('recharge links retain the analysis context and set charge_id once', () => {
  const table = panel('tm-energie-reelle.json', 75);
  const links = table.fieldConfig.overrides.flatMap(item => item.properties
    .filter(property => property.id === 'links').flatMap(property => property.value));
  assert.equal(links.length, 2);
  for (const link of links) {
    for (const name of ['car_id', 'fenetre', 'km', 'work', 'thermique', 'carburant', 'prix_kwh', 'wltp']) {
      assert.ok(link.url.includes('${' + name + ':queryparam}'), name);
    }
    assert.ok(link.url.includes('${__url_time_range}'));
    assert.equal((link.url.match(/var-charge_id=/g) || []).length, 1);
  }
});

test('energy detail panels omit unused calculations and retain displayed fields', () => {
  const dailySql = panel('tm-energie-reelle.json', 25).targets[0].rawSql;
  assert.doesNotMatch(dailySql, /h_clim|is_climate_on/);
  assert.match(dailySql, /AS h_sleep\n\s+FROM gaps g/);
  assert.doesNotMatch(dailySql, /AS h_sleep,\s+FROM/);
  assert.match(dailySql, /sum\(dist\) AS km/);
  for (const field of ['Roulage', 'Sentinelle boulot', 'Arrêt éveillé', 'Veille', 'Conso réelle (kWh/100 km)']) {
    assert.ok(dailySql.includes(`AS "${field}"`), field);
  }

  const parkingSql = panel('tm-energie-reelle.json', 78).targets[0].rawSql;
  assert.doesNotMatch(parkingSql, /AS dist|\bdistance\b/);
  assert.match(parkingSql, /SELECT 'now', p\.t1, p\.t1, l\.r, l\.r, NULL, NULL FROM params p, lastpos l/);
  for (const field of ['Début', 'Fin', 'Lieu', 'Durée', 'Endormi', 'Clim', 'Perte km', 'kWh', 'Puissance moy.', 'dont éveillé']) {
    assert.ok(parkingSql.includes(`AS "${field}"`), field);
  }
});

test('trip distances use fixed metre or kilometre units and durations use min', () => {
  const trip = dashboards.find(entry => entry.name === 'tms-trajet.json').dashboard;
  const unit = (id, field) => {
    const item = trip.panels.find(panel => panel.id === id);
    if (!field) return item.fieldConfig.defaults.unit;
    return item.fieldConfig.overrides.find(override => override.matcher.options === field)
      .properties.find(property => property.id === 'unit').value;
  };

  assert.equal(unit(5), 'suffix: km');
  assert.equal(unit(22, 'Autonomie'), 'suffix: km');
  for (const id of [12, 13, 23]) assert.equal(unit(id), 'suffix: m');
  for (const id of [6, 25]) assert.equal(unit(id), 'suffix: min');
  for (const item of trip.panels) {
    const units = [item.fieldConfig?.defaults?.unit, ...(item.fieldConfig?.overrides || [])
      .flatMap(override => override.properties || [])
      .filter(property => property.id === 'unit').map(property => property.value)];
    assert.ok(!units.some(value => value === 'lengthkm' || value === 'lengthm'), `panel ${item.id}: automatic length unit`);
  }

  const sourceSql = trip.panels.find(item => item.id === 3).targets[0].rawSql;
  assert.match(sourceSql, /d\.duration_min AS "Durée"/);
  const speedSql = trip.panels.find(item => item.id === 25).targets[0].rawSql;
  assert.match(speedSql, /sum\(s\) \/ 60 AS "Minutes"/);
  assert.doesNotMatch(JSON.stringify(trip), /\bmins\b/i);
});

test('driving statistics keep every kilometre value in km', () => {
  const driving = dashboards.find(entry => entry.name === 'tms-stats-conduite.json').dashboard;
  const unit = (id, field) => {
    const item = driving.panels.find(panel => panel.id === id);
    if (!field) return item.fieldConfig.defaults.unit;
    return item.fieldConfig.overrides.find(override => override.matcher.options === field)
      .properties.find(property => property.id === 'unit').value;
  };

  for (const id of [4, 6, 7, 10, 11, 16, 18]) assert.equal(unit(id), 'suffix: km');
  assert.equal(unit(15, 'Km'), 'suffix: km');
  for (const item of driving.panels) {
    const units = [item.fieldConfig?.defaults?.unit, ...(item.fieldConfig?.overrides || [])
      .flatMap(override => override.properties || [])
      .filter(property => property.id === 'unit').map(property => property.value)];
    assert.ok(!units.some(value => value === 'lengthkm' || value === 'lengthm'), `panel ${item.id}: automatic length unit`);
  }
});

const schema = `
  CREATE TEMP TABLE cars (id integer, efficiency double precision);
  CREATE TEMP TABLE positions (id integer, car_id integer, date timestamp, drive_id integer,
    is_climate_on boolean, ideal_battery_range_km double precision, battery_level integer, odometer double precision);
  CREATE TEMP TABLE charging_processes (id integer, car_id integer, position_id integer,
    address_id integer, geofence_id integer, start_date timestamp, end_date timestamp,
    charge_energy_added double precision, charge_energy_used double precision, cost double precision, duration_min double precision);
  CREATE TEMP TABLE charges (charging_process_id integer, date timestamp,
    fast_charger_present boolean, charger_phases integer, fast_charger_brand text,
    rated_battery_range_km double precision, usable_battery_level double precision);
  CREATE TEMP TABLE drives (car_id integer, start_date timestamp, end_date timestamp, distance double precision, end_km double precision);
  CREATE TEMP TABLE addresses (id integer, name text, road text, house_number text, city text, neighbourhood text);
  CREATE TEMP TABLE geofences (id integer, name text);
  INSERT INTO cars VALUES (1, 0.15);
`;

function queryFixture(filename, id, setup = '', newCapacity = '0') {
  const sql = panel(filename, id).targets[0].rawSql
    .replaceAll('$car_id', '1')
    .replaceAll('${kwh_neuf:sqlstring}', `'${newCapacity}'`)
    .replaceAll('$__timezone', 'UTC')
    .replace(/\$__timeFilter\(([^)]+)\)/g, "($1 >= TIMESTAMP '2026-11-01' AND $1 < TIMESTAMP '2026-12-01')");
  const output = execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: `BEGIN; SET LOCAL search_path = pg_temp; ${schema} ${setup}
      SELECT row_to_json(result) FROM (${sql}) result; ROLLBACK;`
  });
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('PostgreSQL fixtures verify empty estimates, climate intervals and recharge totals', {
  skip: process.env.TMS_SQL_TESTS !== '1'
}, () => {
  for (const capacity of ['0', '60']) {
    const [empty] = queryFixture('tms-batterie.json', 3, '', capacity);
    assert.equal(empty['Santé'], null);
    assert.equal(empty['Dégradation'], null);
    assert.equal(empty['Recharges'], 0);
  }
  const batterySetup = `
    INSERT INTO charging_processes (id, car_id, end_date, charge_energy_added) VALUES (1, 1, '2026-11-01', 10);
    INSERT INTO charges (charging_process_id, date, rated_battery_range_km, usable_battery_level)
      VALUES (1, '2026-11-01', 180, 50);
  `;
  const [unknownReference] = queryFixture('tms-batterie.json', 3, batterySetup);
  assert.equal(unknownReference['Santé'], null);
  const [knownReference] = queryFixture('tms-batterie.json', 3, batterySetup, '60');
  assert.equal(knownReference['Santé'], 90);
  assert.equal(knownReference['Dégradation'], 10);

  const [climate] = queryFixture('tms-temperatures.json', 11, `
    INSERT INTO positions (car_id, date, drive_id, is_climate_on, ideal_battery_range_km) VALUES
      (1, '2026-11-01 10:00', NULL, true, 100),
      (1, '2026-11-01 10:01', 11, false, NULL),
      (1, '2026-11-01 10:20', NULL, true, 100);
  `);
  assert.ok(Math.abs(climate['Heures'] - 1 / 60) < 1e-9);
  const [lastClimate] = queryFixture('tms-temperatures.json', 11, `
    INSERT INTO positions (car_id, date, is_climate_on) VALUES (1, '2026-11-01 10:00', true);
  `);
  assert.equal(lastClimate['Heures'], null);

  const [recharge] = queryFixture('tms-stats-recharge.json', 3, `
    INSERT INTO charging_processes (id, car_id, start_date, end_date, charge_energy_added, charge_energy_used, cost, duration_min) VALUES
      (1, 1, '2026-11-01', '2026-11-02', 10, 12, 3, 60),
      (2, 1, '2026-11-03', '2026-11-04', 20, 22, NULL, 30),
      (3, 1, '2026-11-05', '2026-11-06', 5, NULL, 1, 10),
      (4, 2, '2026-11-01', '2026-11-02', 100, 120, 30, 60),
      (5, 1, '2026-11-01', NULL, 100, 120, 30, 60),
      (6, 1, '2026-10-01', '2026-10-02', 100, 120, 30, 60);
    INSERT INTO charges (charging_process_id, fast_charger_present, charger_phases, fast_charger_brand) VALUES
      (1, false, 3, NULL), (1, false, 3, NULL), (2, true, NULL, 'Tesla');
  `);
  assert.equal(recharge['Recharges'], 3);
  assert.equal(recharge['Ajouté'], 35);
  assert.equal(recharge['Prise'], 39);
  assert.equal(recharge['Coût'], 4);
  assert.equal(recharge['Superchargeurs'], null);
  assert.ok(Math.abs(recharge['Prix kWh'] - 4 / 17) < 1e-9);
  assert.equal(recharge['Ajouté AC'], 10);
  assert.equal(recharge['Ajouté DC'], 25);
  assert.equal(recharge['Durée AC'], 3600);
  assert.equal(recharge['Durée DC'], 2400);
});