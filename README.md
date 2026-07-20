# 📘 xcraft-contrib-wpkg

## Aperçu

Le module `xcraft-contrib-wpkg` est une interface JavaScript pour le système de gestion de paquets **WPKG**, un outil inspiré du monde Debian mais fonctionnant de manière autonome. Il fournit une API complète pour manipuler des paquets `.deb` dans l'écosystème Xcraft : construction, installation, désinstallation, publication, archivage et interrogation des paquets, aussi bien pour les architectures Windows que Linux. Le module encapsule l'exécutable en ligne de commande `wpkg_static` (ainsi que `deb2graph` pour les graphes de dépendances) et lui superpose une logique métier Xcraft, notamment un système d'archivage multi-versions et une gestion de dépôts.

## Sommaire

- [Structure du module](#structure-du-module)
- [Fonctionnement global](#fonctionnement-global)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Interactions avec d'autres modules](#interactions-avec-dautres-modules)
- [Détails des sources](#détails-des-sources)
- [Licence](#licence)

## Structure du module

Le module s'organise en trois briques principales :

- **`Wpkg`** (`wpkg.js`) — Classe de haut niveau exposée par le module (`module.exports = (resp) => new Wpkg(resp)`). Elle orchestre la logique métier : recherche de paquets, archivage multi-versions, synchronisation de dépôts, publication.
- **`WpkgBin`** (`lib/bin.js`) — Classe de bas niveau qui construit les arguments et exécute réellement `wpkg_static` (et `deb2graph`), en parsant leurs sorties texte/JSON.
- **`MapLimit`** (`lib/mapLimit.js`) — Petite classe utilitaire dérivée de `Map`, utilisée pour deux caches à taille bornée (résultats de `show` et d'index de paquets).

Toutes les méthodes asynchrones sont écrites sous forme de générateurs et transformées en fonctions à callback/promesse grâce à [gigawatts](`watt.wrapAll`).

## Fonctionnement global

Le module agit comme une couche d'abstraction au-dessus de l'exécutable `wpkg_static`. Ses responsabilités principales :

1. **Construire des paquets** à partir de sources (binaires ou sources), avec compression `zstd` (niveau 3) et génération CMake adaptée à l'OS (`MSYS Makefiles` sous Windows, `Unix Makefiles` ailleurs).
2. **Installer/désinstaller des paquets** dans une racine cible (`targetRoot`), avec gestion des sources APT et des sélections (`auto`, `normal`, `hold`, `reject`).
3. **Gérer des dépôts** : création/mise à jour d'index (`createIndex`), recherche filtrée de paquets (`listIndexPackages`).
4. **Archiver les anciennes versions** d'un paquet tout en gardant la dernière version active dans le dépôt principal.
5. **Interroger les informations** sur les paquets disponibles (`show`, `fields`) ou installés (`list`, `search`, `listFiles`).
6. **Publier/dépublier** des paquets entre dépôts.
7. **Générer des graphes de dépendances** via `deb2graph`.

### Système d'archivage

Chaque fois qu'un dépôt est synchronisé (`_syncRepository`), le module :

1. Reconstruit l'index du dépôt (`wpkg.createIndex`).
2. Regroupe les fichiers `.deb` présents par nom de paquet et par distribution (méthode `_archiving`), en excluant les paquets `-stub`.
3. Compare les versions présentes avec [wpkg-debversion] afin de déterminer la version la plus récente ; toutes les versions plus anciennes sont déplacées vers les archives (`_moveToArchiving`) tandis que la dernière version reste dans le dépôt (copiée en lien de secours grâce au paramètre `backLink`).
4. Pour choisir le dossier d'archive final, `_archiving` consulte l'index préalablement chargé afin de détecter si le paquet appartient à une distribution "spécialisée" (contenant un `+` dans le champ `Distribution` du contrôle) ; dans ce cas, l'archive est stockée sous ce sous-dossier spécifique plutôt que sous la distribution générique.
5. Chaque dossier d'archive d'un paquet contient un fichier `index.json` recensant, par version de base, la liste des versions dérivées et la plus récente (`latest`), ainsi qu'une entrée globale `latest` pour l'ensemble du paquet.

Les archives sont organisées selon la structure :

```
<dépôt>/../wpkg@ver/<distribution>/<nom-paquet>/<version>/<nom-paquet>_<version>_<arch>.deb
```

Les paquets sources (dont le nom se termine par `-src`) sont archivés sous le sous-dossier `sources/` lorsque la distribution ne contient pas de `+`.

### Gestion des versions

Le module s'appuie sur [wpkg-debversion] pour comparer deux versions selon les règles Debian. La fonction interne `maxVersion` (générateur) parcourt une liste de versions et retourne la plus élevée. Elle est utilisée aussi bien lors de l'archivage que lors du retrait d'une version archivée (`moveArchive`), afin de recalculer la nouvelle version `latest` d'un paquet.

### Optimisations et mise en cache

- **`Wpkg.#showCache`** (`MapLimit(100)`) — met en cache le résultat de `show`, indexé par le hash MD5 du fichier `.deb` (issu du fichier `.md5sum` associé).
- **`WpkgBin.#indexCache`** (`MapLimit(20)`) — met en cache le résultat de l'analyse JSON d'un index de dépôt, indexé par le hash SHA-256 du fichier d'index (via [xcraft-core-utils]), afin d'éviter de ré-invoquer `wpkg_static --list-index-packages-json` inutilement.
- Les opérations `install`/`build`/`upgrade`/`autoremove`/`remove` passent par [xcraft-core-subst](`xSubst.wrap`) qui fournit un répertoire temporaire de travail isolé pour l'exécution de `wpkg_static`.

### Gestion des erreurs

Les erreurs de type `ENOENT` (fichier/dossier absent) sont généralement absorbées silencieusement lorsqu'elles correspondent à un cas normal (dépôt pas encore créé, fichier `.md5sum` absent, etc.), alors que les autres erreurs sont relancées (`throw ex`). La recherche de paquet (`_lookForPackage`) journalise un avertissement (`log.warn`) et retourne l'erreur `'package not found'` lorsque le paquet demandé n'existe dans aucun des dépôts consultés.

## Exemples d'utilisation

### Construction d'un paquet

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);

wpkg.build('/path/to/package', null, 'my-distribution', (err) => {
  if (!err) {
    resp.log.info('Package built successfully');
  }
});
```

### Installation d'un paquet avec ses dépendances

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);

wpkg.install('my-package', 'amd64', 'my-distribution', null, false, (err) => {
  if (!err) {
    resp.log.info('Package installed successfully');
  }
});
```

### Installation d'une version archivée précise

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);

yield wpkg.installFromArchive(
  'my-package',
  'amd64',
  'my-distribution',
  '1.2.3',
  null,
  false
);
```

### Vérification et comparaison de versions

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);

const isAvailable = yield wpkg.isPublished(
  'my-package',
  '1.0.0',
  'amd64',
  'my-distribution',
  null
);

const isGreater = yield wpkg.isV1Greater('1.2.0', '1.1.0');
```

### Génération d'un graphe de dépendances

```javascript
const wpkg = require('xcraft-contrib-wpkg')(resp);

yield wpkg.graph(['package1', 'package2'], 'amd64', 'my-distribution');
```

## Interactions avec d'autres modules

- **[xcraft-contrib-pacman]** — Fournit les chemins de dépôt (`getDebRoot`) et de racine cible (`getTargetRoot`) en fonction de la distribution.
- **[xcraft-core-fs]** — Opérations sur le système de fichiers (copie, déplacement, suppression, lecture/écriture JSON).
- **[xcraft-core-platform]** — Détermine l'architecture de la chaîne d'outils (`getToolchainArch`) et le système d'exploitation courant.
- **[xcraft-core-etc]** — Charge les configurations `xcraft` (ex. `pkgDebRoot`, `pkgTargetRoot`) et `xcraft-contrib-pacman` (ex. `pkgIndex`, `wpkgTemp`, `pkgToolchainRepository`).
- **[xcraft-core-process]** — Exécute les binaires externes `wpkg_static` et `deb2graph` en tant que sous-processus, avec journalisation via `xlog`.
- **[xcraft-core-subst]** — Fournit un répertoire temporaire isolé pour l'exécution des commandes wpkg.
- **[xcraft-core-utils]** — Fonctions utilitaires : hachage SHA-256 (cache d'index) et conversion de filtres en expressions régulières.
- **[xcraft-core-placeholder]** — Génère le fichier de contrôle utilisé pour créer un nouvel `admindir` à partir d'un template.
- **[wpkg-debversion]** — Compare deux versions de paquets selon les règles Debian.
- **[gigawatts]** — Transforme les générateurs en fonctions asynchrones (callback ou yield).
- **`which`** — Détecte la présence de l'outil `dot` (Graphviz) pour la génération de graphes SVG.

## Détails des sources

### `wpkg.js`

Fichier principal exposant la classe `Wpkg`, instanciée via `module.exports = (resp) => new Wpkg(resp)`. Cette classe centralise toute la logique métier au-dessus de `WpkgBin`.

#### Méthodes publiques

- **`getArchivesPath(repositoryPath, distribution)`** — Calcule le chemin du dossier d'archives (`wpkg@ver/<distribution>`) associé à un dépôt.
- **`listIndexPackages(repositoryPaths, arch, filters, options)`** — Récupère la liste des paquets disponibles dans un ou plusieurs dépôts, filtrée par nom, version, architecture ou distribution ; `options.greater` restreint le résultat à la version la plus élevée par paquet.
- **`copyFromArchiving(packageName, arch, version, distribution)`** — Copie une version archivée d'un paquet vers le dépôt principal puis resynchronise ce dépôt.
- **`getArchiveLatestVersion(packageName, distribution)`** — Retourne la dernière version archivée d'un paquet.
- **`listArchiveVersions(packageName, distribution)`** — Liste toutes les versions archivées d'un paquet.
- **`moveArchive(name, version, distribution, destinationDir)`** — Déplace une version archivée hors du système d'archivage (vers `destinationDir`) et met à jour l'index correspondant ; refuse l'opération si la version est la seule/dernière disponible.
- **`build(packagePath, outputRepository, distribution, callback)`** — Construit un paquet standard puis synchronise le dépôt de sortie.
- **`buildSrc(packagePath, outputRepository, distribution, callback)`** — Construit un paquet source.
- **`buildFromSrc(packageName, arch, repository, distribution, callback)`** — Construit un paquet binaire à partir d'un paquet source ; sans nom de paquet, reconstruit l'ensemble du dépôt `sources/`.
- **`listFiles(packageName, arch, callback)`** — Liste les fichiers de données d'un paquet installé.
- **`list(arch, distribution, pattern, callback)`** — Liste les paquets installés (racine), avec filtrage optionnel par motif.
- **`search(arch, distribution, pattern, callback)`** — Recherche des fichiers correspondant à un motif dans les paquets installés.
- **`unlock(arch, distribution, callback)`** — Supprime le verrou de la base de données `wpkg`.
- **`install(packageName, arch, distribution, targetRoot, reinstall, callback)`** — Recherche puis installe un paquet et ses dépendances.
- **`installByName(packageName, arch, distribution, targetRoot, reinstall, callback)`** — Installe un paquet en ne fournissant que son nom (cas des dépôts externes où le support HTTP n'est pas implémenté).
- **`installFromArchive(packageName, arch, distribution, version, targetRoot, reinstall, next)`** — Localise puis installe une version précise depuis les archives.
- **`isInstalled(packageName, arch, distribution, callback)`** — Vérifie si un paquet est déjà installé.
- **`fields(packageName, arch, distribution, callback)`** — Récupère certains champs (`Version`, `X-Status`) d'un paquet installé.
- **`getDebLocation(packageName, arch, version, distribution, next)`** — Résout l'emplacement d'un fichier `.deb`, en tenant compte de son éventuelle localisation en archive si une version est spécifiée.
- **`show(packageName, arch, version, distribution)`** — Retourne les métadonnées d'un paquet au format JSON, avec mise en cache par hash MD5.
- **`remove(packageName, arch, distribution, recursive, callback)`** — Désinstalle un paquet, avec option récursive pour ses dépendances.
- **`autoremove(arch, distribution)`** — Supprime automatiquement les paquets implicites devenus inutiles.
- **`setSelection(packageName, arch, selection, distribution)`** — Modifie la sélection d'un paquet (`auto`, `normal`, `hold`, `reject`).
- **`createAdmindir(arch, distribution, targetRoot, callback)`** — Crée le répertoire d'administration `wpkg` dans la racine cible à partir du template `templates/admindir.control`.
- **`addHooks(hooks, arch, distribution, callback)`** — Enregistre des scripts de hooks globaux (shell ou batch) dans l'admindir.
- **`addSources(sourcePath, arch, targetRoot, next)`** — Ajoute une entrée de source APT si elle n'est pas déjà présente (lecture directe de `sources.list` pour éviter le verrou de la base).
- **`removeSources(sourcePath, arch, targetRoot, next)`** — Retire une entrée de source APT par son contenu.
- **`update(arch, targetRoot, callback)`** — Met à jour la liste des paquets disponibles depuis les sources configurées.
- **`upgrade(arch, targetRoot, callback)`** — Met à niveau les paquets installés dans la racine cible.
- **`publish(packageName, arch, inputRepository, outputRepository, distribution, callback)`** — Copie un paquet d'un dépôt source vers un dépôt de destination puis resynchronise ce dernier.
- **`unpublish(packageName, arch, repository, distribution, updateIndex, callback)`** — Supprime un paquet d'un dépôt, avec resynchronisation optionnelle de l'index.
- **`isPublished(packageName, packageVersion, arch, distribution, repositoryPath, next)`** — Vérifie si une version précise d'un paquet est publiée dans un dépôt.
- **`targetExists(distribution)`** — Vérifie si la racine cible (`targetRoot`) existe sur le disque.
- **`syncRepository(distribution, next)`** — Point d'entrée public pour synchroniser un dépôt (recrée l'index et archive les anciennes versions).
- **`graph(packageNames, arch, distribution, next)`** — Génère un graphe de dépendances pour une liste de paquets, en essayant la distribution demandée puis la distribution par défaut.
- **`isV1Greater(v1, v2)`** — Détermine si la version `v1` est strictement supérieure à `v2`.

#### Fonctions et méthodes internes notables

- **`maxVersion(versions)`** — Générateur qui extrait la version maximale d'une liste en s'appuyant sur [wpkg-debversion].
- **`_lookForPackage(packageName, packageVersion, arch, distribution, repositoryPath, callback)`** — Cœur de la résolution de paquet : combine le dépôt demandé et le dépôt racine `pkgDebRoot`, filtre par nom/version/architecture/distribution via `listIndexPackages`, puis complète le résultat avec le hash MD5 du fichier trouvé.
- **`_archiving(wpkg, repositoryPath, distributions, next)`** — Regroupe les `.deb` par nom de paquet, archive toutes les versions sauf la plus récente, et détermine le sous-dossier d'archive final (`getFinalArchivesPath`) en fonction d'une éventuelle distribution spécialisée.
- **`_moveToArchiving(wpkg, packagesPath, archivesPath, deb, backLink)`** — Déplace (ou copie si `backLink`) un `.deb` et son `.md5sum` vers les archives, régénère l'index de l'archive et met à jour le fichier `index.json` du paquet.
- **`_syncRepository(repositoryPath)`** — Enchaîne la création d'index, l'archivage, puis une nouvelle création d'index après archivage.
- **`_build(packagePath, isSource, outputRepository, distribution, callback)`** — Implémentation commune à `build`/`buildSrc`.

### `lib/bin.js`

Contient la classe `WpkgBin`, responsable de l'invocation directe des binaires externes `wpkg_static` et `deb2graph`, ainsi que du parsing de leurs sorties.

Chaque instance est liée à une racine cible (`targetRoot`) et peut recevoir des variables d'environnement additionnelles (`env`) injectées lors du spawn du processus, par exemple `PEON_DISTRIBUTION` utilisée par `buildFromSrc`.

#### Méthodes principales

- **`_runWpkg(args, lastArg, tmp, callbackStdout, next)`** — Exécute `wpkg_static` via [xcraft-core-process], journalise le début/fin de commande et retourne le code de sortie.
- **`_run(args, lastArg, callbackStdout, next)`** — Enrobe `_runWpkg` avec un répertoire temporaire fourni par [xcraft-core-subst].
- **`_runDeb2graph(args, callbackStdout, next)`** — Exécute `deb2graph`, en ajoutant `--skip-svg` si l'outil `dot` (Graphviz) est absent.
- **`_addRepositories(distribution)`** — Construit l'argument `--repository` à partir du dépôt correspondant à la distribution, s'il existe sur le disque.
- **`build(repositoryPath, packagePath, arch, distribution, next)`** — Construit un paquet binaire (compression `zstd`, niveau 3, exclusion de `.gitignore`/`.gitattributes`) ; ajoute les dépôts de dépendances uniquement si `packagePath` est un `.deb` (et non un dossier source).
- **`buildSrc(repositoryPath, distribution, next)`** — Construit un paquet source.
- **`createIndex(repositoryPath, indexName, next)`** — Recrée l'index d'un dépôt de façon récursive (profondeur 1).
- **`install(packagePath, arch, distribution, reinstall, next)`** — Installe un paquet, avec `--skip-same-version` si `reinstall` est faux.
- **`isInstalled(packageName, arch, next)`** — Teste la présence d'un paquet installé.
- **`fields(packageName, arch, next)`** — Récupère `Version` et `X-Status` d'un paquet, retourne `null` en cas d'échec.
- **`show(packagePath, distribution, next)`** — Extrait un ensemble de champs de contrôle (dont `X-Craft-Packages-<distribution>`, `X-Craft-Build-Depends`, `X-Craft-Sub-Packages`, etc.) au format JSON.
- **`remove(packageName, arch, recursive, next)`** — Désinstalle un paquet.
- **`autoremove(arch, next)`** — Supprime les paquets implicites inutilisés.
- **`setSelection(packageName, arch, selection, next)`** — Modifie la sélection d'un paquet.
- **`createAdmindir(controlFile, arch, next)`** — Crée l'admindir puis génère un fichier `sources.list` vide (nécessaire pour éviter des erreurs lors des futures mises à jour).
- **`addSources(source, arch, next)` / `removeSources(sourceRow, arch, next)`** — Ajoutent/retirent une source APT.
- **`listSources(arch, listOut, rows, next)`** — Liste les sources configurées (conservée pour compatibilité, mais non utilisée par `Wpkg.addSources`/`removeSources` afin d'éviter le verrou de base de données).
- **`listFiles(packageName, arch, listOut, next)`** — Liste les fichiers d'un paquet installé.
- **`list(arch, pattern, listOut, next)`** — Liste les paquets installés, avec parsing des colonnes `Name`/`Version`/`Description`.
- **`search(arch, pattern, listOut, next)`** — Recherche des fichiers par motif dans les paquets installés.
- **`unlock(arch, next)`** — Supprime le verrou de base de données.
- **`update(arch, next)` / `upgrade(arch, next)`** — Mettent à jour/à niveau les paquets, en vérifiant au préalable l'existence de `sources.list`.
- **`isV1Greater(v1, v2, next)`** — Compare deux versions via `--compare-versions`.
- **`listIndexPackages(repositoryPath, arch, filters, listOut, options, next)`** — Analyse l'index JSON d'un dépôt (`--list-index-packages-json`), avec mise en cache par hash SHA-256, filtrage par expressions régulières, et sélection de la version la plus élevée par paquet si `options.greater` est vrai.
- **`addHooks(hooks, arch, next)`** — Ajoute des hooks globaux.
- **`graph(debs, arch, next)`** — Génère un graphe de dépendances via `deb2graph`.

### `lib/mapLimit.js`

Classe utilitaire qui étend `Map` pour borner le nombre d'entrées en mémoire. Lorsqu'une nouvelle entrée est ajoutée alors que la limite (`max`) est atteinte, l'entrée la plus ancienne (première insérée, selon l'ordre naturel des `Map`) est automatiquement supprimée. Cette classe sert de base aux deux caches du module (`Wpkg.#showCache` et `WpkgBin.#indexCache`).

#### Méthodes publiques

- **`constructor(max)`** — Initialise le cache avec une capacité maximale.
- **`set(key, value)`** — Ajoute ou met à jour une entrée, en évinçant les plus anciennes si nécessaire pour respecter la capacité.

## Licence

Ce module est distribué sous [licence MIT](./LICENSE).

---

_Ce contenu a été généré par IA_

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
