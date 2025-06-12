# 📘 Documentation du module xcraft-contrib-wpkg

## Aperçu

Le module `xcraft-contrib-wpkg` est une interface JavaScript pour le système de gestion de paquets WPKG (Windows Package Manager). Il fournit une API complète pour manipuler des paquets dérivés de Debian (.deb) dans l'écosystème Xcraft, permettant la création, l'installation, la mise à jour et la gestion de paquets logiciels. Bien que ces paquets utilisent l'extension .deb, ils ne suivent pas strictement le standard Debian.

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Configuration avancée](#configuration-avancée)
- [Détails des sources](#détails-des-sources)
- [Fonctionnalités avancées](#fonctionnalités-avancées)

## Structure du module

- **Wpkg** - Classe principale qui encapsule les fonctionnalités de gestion de paquets
- **WpkgBin** - Classe qui gère l'exécution des commandes WPKG en ligne de commande
- **MapLimit** - Classe utilitaire pour limiter la taille des caches en mémoire

## Fonctionnement global

Le module agit comme une couche d'abstraction au-dessus de l'outil en ligne de commande `wpkg_static`. Il permet de:

1. **Construire des paquets** à partir de sources
2. **Installer des paquets** dans un environnement cible
3. **Gérer des dépôts** de paquets (création d'index, synchronisation)
4. **Archiver des paquets** pour conserver différentes versions
5. **Interroger les informations** sur les paquets disponibles ou installés

Le module utilise un système d'archivage sophistiqué qui permet de conserver plusieurs versions d'un même paquet, tout en maintenant une version active dans le dépôt principal. Les versions archivées sont organisées par distribution et par paquet, avec un système d'indexation qui facilite leur récupération.

## Exemples d'utilisation

### Création d'un paquet

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
wpkg.build('/path/to/package', null, 'distribution-name', (err) => {
  if (!err) {
    console.log('Package built successfully');
  }
});
```

### Installation d'un paquet

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
wpkg.install(
  'package-name',
  'amd64',
  'distribution-name',
  null,
  false,
  (err) => {
    if (!err) {
      console.log('Package installed successfully');
    }
  }
);
```

### Vérification de la disponibilité d'un paquet

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
const isAvailable = yield wpkg.isPublished(
  'package-name',
  '1.0.0',
  'amd64',
  'distribution-name',
  null
);
if (isAvailable) {
  console.log('Package is available');
} else {
  console.log('Package is not available');
}
```

### Installation d'une version spécifique depuis les archives

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
yield wpkg.installFromArchive(
  'package-name',
  'amd64',
  'distribution-name',
  '1.2.3',
  null,
  false
);
console.log('Archived package version installed successfully');
```

### Comparaison de versions

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
const isGreater = yield wpkg.isV1Greater('1.2.0', '1.1.0');
console.log(`Version 1.2.0 is greater than 1.1.0: ${isGreater}`);
```

### Génération d'un graphe de dépendances

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);
yield wpkg.graph(['package1', 'package2'], 'amd64', 'distribution-name');
console.log('Dependency graph generated');
```

## Interactions avec d'autres modules

- **[xcraft-core-fs]** - Utilisé pour les opérations sur le système de fichiers
- **[xcraft-contrib-pacman]** - Utilisé pour obtenir les chemins des dépôts et des racines cibles
- **[xcraft-core-platform]** - Utilisé pour déterminer l'architecture de la chaîne d'outils
- **[wpkg-debversion]** - Utilisé pour comparer les versions de paquets Debian
- **[xcraft-core-etc]** - Utilisé pour charger les configurations
- **[xcraft-core-process]** - Utilisé pour exécuter les commandes wpkg_static
- **[xcraft-core-subst]** - Utilisé pour la substitution de variables dans les chemins
- **[xcraft-core-utils]** - Utilisé pour diverses fonctions utilitaires
- **[xcraft-core-placeholder]** - Utilisé pour la gestion des templates
- **[gigawatts]** - Utilisé pour la gestion des générateurs et des callbacks asynchrones
- **which** - Utilisé pour localiser les exécutables dans le PATH

## Configuration avancée

Le module utilise les configurations suivantes:

| Option                 | Description                                    | Type   | Valeur par défaut                 |
| ---------------------- | ---------------------------------------------- | ------ | --------------------------------- |
| pkgDebRoot             | Chemin racine pour les dépôts de paquets       | String | Défini dans xcraft-core-etc       |
| pkgTargetRoot          | Chemin racine pour l'installation des paquets  | String | Défini dans xcraft-core-etc       |
| pkgToolchainRepository | Nom du dépôt de la chaîne d'outils             | String | Défini dans xcraft-contrib-pacman |
| wpkgTemp               | Répertoire temporaire pour les opérations WPKG | String | Défini dans xcraft-contrib-pacman |
| pkgIndex               | Nom du fichier d'index pour les dépôts         | String | Défini dans xcraft-contrib-pacman |

## Détails des sources

### `wpkg.js`

Ce fichier contient la classe principale `Wpkg` qui fournit l'API de haut niveau pour interagir avec le système de paquets. La classe utilise un cache statique pour optimiser les performances des opérations fréquentes comme `show`.

#### Méthodes publiques

- **`getArchivesPath(repositoryPath, distribution)`** — Retourne le chemin vers les archives pour une distribution donnée.
- **`listIndexPackages(repositoryPaths, arch, filters, options)`** — Récupère une liste de paquets disponibles dans un dépôt selon des filtres.
- **`copyFromArchiving(packageName, arch, version, distribution)`** — Copie un paquet depuis les archives vers le dépôt principal.
- **`getArchiveLatestVersion(packageName, distribution)`** — Récupère la dernière version d'un paquet dans les archives.
- **`listArchiveVersions(packageName, distribution)`** — Liste toutes les versions d'un paquet disponibles dans les archives.
- **`moveArchive(name, version, distribution, destinationDir)`** — Déplace une version archivée vers un autre emplacement.
- **`build(packagePath, outputRepository, distribution, callback)`** — Construit un nouveau paquet standard.
- **`buildSrc(packagePath, outputRepository, distribution, callback)`** — Construit un nouveau paquet source.
- **`buildFromSrc(packageName, arch, repository, distribution, callback)`** — Construit un paquet binaire à partir d'un paquet source.
- **`listFiles(packageName, arch, callback)`** — Liste les fichiers d'un paquet.
- **`list(arch, distribution, pattern, callback)`** — Liste les paquets racine.
- **`search(arch, distribution, pattern, callback)`** — Recherche des fichiers dans les paquets installés.
- **`unlock(arch, distribution, callback)`** — Déverrouille la base de données principale.
- **`install(packageName, arch, distribution, targetRoot, reinstall, callback)`** — Installe un paquet avec ses dépendances.
- **`installByName(packageName, arch, distribution, targetRoot, reinstall, callback)`** — Installe un paquet par son nom (pour les dépôts externes).
- **`installFromArchive(packageName, arch, distribution, version, targetRoot, reinstall, next)`** — Installe un paquet depuis les archives.
- **`isInstalled(packageName, arch, distribution, callback)`** — Vérifie si un paquet est déjà installé.
- **`fields(packageName, arch, distribution, callback)`** — Récupère certains champs d'un paquet.
- **`getDebLocation(packageName, arch, version, distribution, next)`** — Récupère l'emplacement d'un paquet deb.
- **`show(packageName, arch, version, distribution)`** — Récupère les champs d'un paquet sous forme de JSON.
- **`remove(packageName, arch, distribution, recursive, callback)`** — Supprime un paquet.
- **`autoremove(arch, distribution)`** — Supprime automatiquement les paquets implicites et non utilisés.
- **`setSelection(packageName, arch, selection, distribution)`** — Définit la sélection d'un paquet (auto, normal, hold, reject).
- **`createAdmindir(arch, distribution, targetRoot, callback)`** — Crée le répertoire d'administration dans la racine cible.
- **`addHooks(hooks, arch, distribution, callback)`** — Ajoute un ou plusieurs hooks globaux dans l'admindir.
- **`addSources(sourcePath, arch, targetRoot, next)`** — Ajoute une nouvelle source dans l'installation cible.
- **`removeSources(sourcePath, arch, targetRoot, next)`** — Supprime une source de l'installation cible.
- **`update(arch, targetRoot, callback)`** — Met à jour la liste des paquets disponibles depuis le dépôt.
- **`upgrade(arch, targetRoot, callback)`** — Met à niveau les paquets dans la racine cible.
- **`publish(packageName, arch, inputRepository, outputRepository, distribution, callback)`** — Publie un paquet dans un dépôt spécifié.
- **`unpublish(packageName, arch, repository, distribution, updateIndex, callback)`** — Dépublie un paquet d'un dépôt spécifié.
- **`isPublished(packageName, packageVersion, arch, distribution, repositoryPath, next)`** — Vérifie si un paquet est déjà publié.
- **`targetExists(distribution)`** — Vérifie si la racine cible existe.
- **`syncRepository(distribution, next)`** — Synchronise le dépôt avec les dépôts d'archives.
- **`graph(packageNames, arch, distribution, next)`** — Génère un graphe pour une liste de paquets.
- **`isV1Greater(v1, v2)`** — Compare deux versions de paquets pour déterminer si v1 est supérieure à v2.

#### Méthodes privées

- **`_lookForPackage(packageName, packageVersion, archRoot, distribution, repositoryPath, callback)`** — Recherche un paquet spécifique dans le dépôt.
- **`_build(packagePath, isSource, outputRepository, distribution, callback)`** — Méthode interne pour construire un paquet.
- **`_archiving(wpkg, repositoryPath, distributions, next)`** — Gère l'archivage des paquets.
- **`_moveToArchiving(wpkg, packagesPath, archivesPath, deb, backLink)`** — Déplace un paquet vers les archives.
- **`_syncRepository(repositoryPath)`** — Synchronise un dépôt avec ses archives.

#### Fonctions utilitaires

- **`maxVersion(versions)`** — Fonction générateur qui extrait la version maximale d'une liste de versions en utilisant wpkg-debversion.

### `lib/bin.js`

Ce fichier contient la classe `WpkgBin` qui encapsule l'exécution des commandes WPKG en ligne de commande. Elle gère l'exécution des commandes `wpkg_static` avec les arguments appropriés, le traitement des sorties de commande et la mise en cache des résultats pour optimiser les performances.

La classe utilise un cache statique pour les résultats des opérations d'indexation avec une limite de 20 entrées.

#### Méthodes principales

- **`_runWpkg(args, lastArg, tmp, callbackStdout, next)`** — Exécute une commande wpkg_static avec gestion des sorties.
- **`_run(args, lastArg, callbackStdout, next)`** — Wrapper pour l'exécution de commandes avec substitution de variables.
- **`_runDeb2graph(args, callbackStdout, next)`** — Exécute la commande deb2graph pour générer des graphes de dépendances.
- **`_addRepositories(distribution)`** — Ajoute les chemins des dépôts aux arguments de commande.
- **`build(repositoryPath, packagePath, arch, distribution, next)`** — Construction de paquets binaires avec support de zstd et niveau de compression 3.
- **`buildSrc(repositoryPath, distribution, next)`** — Construction de paquets sources.
- **`createIndex(repositoryPath, indexName, next)`** — Création d'index de dépôts avec recherche récursive.
- **`install(packagePath, arch, distribution, reinstall, next)`** — Installation de paquets avec option de saut des versions identiques.
- **`isInstalled(packageName, arch, next)`** — Vérifie si un paquet est installé.
- **`fields(packageName, arch, next)`** — Récupère des champs spécifiques d'un paquet (Version, X-Status).
- **`show(packagePath, distribution, next)`** — Affiche les détails d'un paquet au format JSON avec format personnalisé.
- **`remove(packageName, arch, recursive, next)`** — Suppression de paquets avec option récursive.
- **`autoremove(arch, next)`** — Supprime automatiquement les paquets non utilisés.
- **`setSelection(packageName, arch, selection, next)`** — Définit la sélection d'un paquet.
- **`createAdmindir(controlFile, arch, next)`** — Crée le répertoire d'administration et génère un fichier sources.list vide.
- **`addSources(source, arch, next)`** — Ajoute une source APT.
- **`removeSources(sourceRow, arch, next)`** — Supprime une source APT par numéro de ligne.
- **`listSources(arch, listOut, rows, next)`** — Liste les sources configurées.
- **`listFiles(packageName, arch, listOut, next)`** — Liste les fichiers d'un paquet.
- **`list(arch, pattern, listOut, next)`** — Liste les paquets installés avec parsing des colonnes.
- **`search(arch, pattern, listOut, next)`** — Recherche des fichiers dans les paquets installés.
- **`unlock(arch, next)`** — Déverrouille la base de données.
- **`update(arch, next)`** — Met à jour la liste des paquets disponibles (vérifie l'existence de sources.list).
- **`upgrade(arch, next)`** — Met à niveau les paquets (vérifie l'existence de sources.list).
- **`isV1Greater(v1, v2, next)`** — Compare deux versions de paquets.
- **`listIndexPackages(repositoryPath, arch, filters, listOut, options, next)`** — Analyse les index de paquets avec mise en cache SHA256.
- **`addHooks(hooks, arch, next)`** — Ajoute des hooks globaux.
- **`graph(debs, arch, next)`** — Génère un graphe de dépendances avec détection automatique de Graphviz.

### `lib/mapLimit.js`

Une classe utilitaire simple qui étend `Map` pour limiter le nombre d'entrées. Elle est utilisée pour implémenter des caches à taille limitée dans le module.

Cette classe supprime automatiquement les entrées les plus anciennes lorsque la limite est atteinte, ce qui permet d'éviter une consommation excessive de mémoire tout en maintenant les performances des opérations fréquentes.

#### Méthodes

- **`constructor(max)`** — Initialise le cache avec une taille maximale spécifiée.
- **`set(key, value)`** — Ajoute ou met à jour une entrée, supprimant automatiquement les plus anciennes si nécessaire.

## Fonctionnalités avancées

### Système d'archivage

Le module implémente un système d'archivage sophistiqué qui permet de:

1. Conserver plusieurs versions d'un même paquet
2. Organiser les versions par distribution
3. Maintenir un index des versions disponibles
4. Récupérer facilement une version spécifique

Les archives sont organisées selon la structure:

```
/archives/wpkg@ver/distribution/package-name/version/package-name_version_arch.deb
```

Chaque répertoire de paquet contient également un fichier `index.json` qui répertorie toutes les versions disponibles et identifie la version la plus récente. L'index maintient une structure hiérarchique avec les versions de base et leurs variantes.

### Gestion des versions

Le module utilise `wpkg-debversion` pour comparer les versions de paquets selon les règles Debian. Cela permet de:

1. Déterminer quelle version est la plus récente
2. Archiver automatiquement les anciennes versions
3. Maintenir la version la plus récente dans le dépôt principal

La fonction `maxVersion` est utilisée pour extraire la version maximale d'une liste de versions. Le système distingue les versions de base (sans suffixe) des versions avec suffixes.

### Optimisation des performances

Le module utilise plusieurs techniques pour optimiser les performances:

1. **Caches limités** - Utilisation de la classe `MapLimit` pour mettre en cache les résultats fréquemment utilisés
2. **Traitement asynchrone** - Utilisation de `gigawatts` pour gérer les opérations asynchrones de manière efficace
3. **Exécution optimisée** - Utilisation de `xcraft-core-process` pour exécuter les commandes externes de manière optimisée
4. **Cache d'index** - Les résultats d'analyse des index de paquets sont mis en cache avec un hash SHA256 du fichier d'index
5. **Cache de show** - Les résultats de la commande `show` sont mis en cache par hash MD5 du paquet

### Génération de graphes de dépendances

Le module permet de générer des graphes de dépendances pour visualiser les relations entre les paquets en utilisant l'outil `deb2graph`:

```javascript
yield wpkg.graph(['package1', 'package2'], 'amd64', 'distribution-name');
```

Le module détecte automatiquement la présence de l'outil `dot` (Graphviz) et adapte les arguments en conséquence en ajoutant `--skip-svg` si Graphviz n'est pas disponible.

### Gestion des distributions spéciales

Le module gère intelligemment les paquets sources et les distributions spéciales:

- Les paquets se terminant par `-src` sont traités comme des paquets sources
- Les distributions contenant un `+` sont considérées comme des distributions spécialisées
- L'archivage adapte automatiquement les chemins selon le type de paquet
- Les paquets sources sont placés dans le répertoire `sources/` lors de l'archivage

### Compression et optimisations de build

Le module utilise des paramètres optimisés pour la construction des paquets:

- **Compresseur** : zstd (plus rapide que gzip/xz)
- **Niveau de compression** : 3 (équilibre entre taille et vitesse)
- **Générateur CMake** : Adapté à la plateforme (MSYS Makefiles sur Windows, Unix Makefiles ailleurs)
- **Gestion des fichiers spéciaux** : Exclusion automatique des fichiers `.gitignore` et `.gitattributes`

_Cette documentation a été mise à jour automatiquement._

[xcraft-core-fs]: https://github.com/Xcraft-Inc/xcraft-core-fs
[xcraft-contrib-pacman]: https://github.com/Xcraft-Inc/xcraft-contrib-pacman
[xcraft-core-platform]: https://github.com/Xcraft-Inc/xcraft-core-platform
[wpkg-debversion]: https://github.com/Xcraft-Inc/wpkg-debversion
[xcraft-core-etc]: https://github.com/Xcraft-Inc/xcraft-core-etc
[xcraft-core-process]: https://github.com/Xcraft-Inc/xcraft-core-process
[xcraft-core-subst]: https://github.com/Xcraft-Inc/xcraft-core-subst
[xcraft-core-utils]: https://github.com/Xcraft-Inc/xcraft-core-utils
[xcraft-core-placeholder]: https://github.com/Xcraft-Inc/xcraft-core-placeholder
[gigawatts]: https://github.com/Xcraft-Inc/gigawatts