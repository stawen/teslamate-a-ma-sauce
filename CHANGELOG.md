# Historique des versions

## À venir
- Énergie réelle : le camembert réutilise les résultats du bilan au lieu de recalculer les événements et les stationnements
- Statistiques de recharge : une seule agrégation des mesures par recharge ; les camemberts AC/DC réutilisent les totaux d'énergie et de durée
- Correction : la santé et la dégradation de la batterie restent inconnues lorsqu'une capacité nécessaire au calcul manque
- Correction : la durée de climatisation à l'arrêt ne traverse plus les relevés de conduite exclus et n'ajoute plus 15 minutes au dernier relevé ; les positions sans autonomie sont conservées pour calculer les intervalles
- Énergie réelle : les liens vers une recharge conservent les réglages de période, de coût et de comparaison thermique
- Tests des JSON et des dépendances Grafana, avec scénarios SQL sur PostgreSQL 18 dans la CI

## 1.4 — 02/11/2026
- Installation possible avec docker-compose, sans jeton ni script (proposée par @stawen)
- Requêtes nettement plus rapides, pensées pour les petites machines (Raspberry Pi) : elles utilisent désormais les index de TeslaMate. Sur une base de test de 2 millions de positions, le temps de calcul de l'ensemble des tableaux est divisé par 5 environ
- Correction : l'autonomie à 100 % (Mises à jour) pouvait chuter certains jours à cause des positions enregistrées en mode streaming
- Suppression d'un doublon du tableau Énergie réelle dans le dossier `dashboards/`

## 1.3 — 30/10/2026
- Accueil : nouvelle carte « Ma voiture » (panneau Canvas) avec l'état, la batterie, l'autonomie, les températures, le lieu, la dernière recharge et la version logicielle
- Cartes en fond CARTO, sombre ou clair selon le thème de Grafana
- Détail d'un trajet : parcours fléché, coloré selon la vitesse
- Visites : carte de chaleur des routes empruntées
- Aucun plugin à installer : tout reste dans Grafana de base

## 1.2 — 30/10/2026
- Correction : la ligne TOTAL des tableaux apparaissait en double
- Captures d'écran sur la page du dépôt

## 1.1 — 30/10/2026
- Raccourcis de période en français dans tous les tableaux (cette semaine, le mois dernier, les 6 derniers mois…)
- Énergie réelle : choix entre « les X derniers km » et « la période choisie »

## 1.0 — 30/10/2026
- Première version : 24 tableaux en français, menu commun, page d'accueil
- Énergie réelle : conso réelle, sentinelle au boulot, autonomie WLTP / EPA / réelle, comparaison avec une voiture thermique
- Scripts d'import automatique pour Windows (PowerShell) et Linux / Unraid
