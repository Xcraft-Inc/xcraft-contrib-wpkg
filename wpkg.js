'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');

const xFs = require('xcraft-core-fs');
const xPacman = require('xcraft-contrib-pacman');

const WpkgBin = require('./lib/bin.js');
const MapLimit = require('./lib/mapLimit.js');
const {getToolchainArch} = require('xcraft-core-platform');
const debversion = require('wpkg-debversion');

/**
 * Extract the max version by using wpkg.
 *
 * @yields
 * @param {Array} versions List of versions where extract the max
 * @returns {string} the max version
 */
function* maxVersion(versions) {
  let maxVersion = versions.shift();

  if (!versions.length) {
    return maxVersion;
  }

  for (const version of versions) {
    const comp = yield debversion(version, maxVersion);
    if (comp > 0) {
      maxVersion = version;
    }
  }

  return maxVersion;
}
class Wpkg {
  static #showCache = new MapLimit(100);

  constructor(resp) {
    this._resp = resp;

    const xEtc = require('xcraft-core-etc')(null, this._resp);
    this._xcraftConfig = xEtc.load('xcraft');
    this._pacmanConfig = xEtc.load('xcraft-contrib-pacman');

    watt.wrapAll(
      this,
      'addSources',
      'autoremove',
      'copyFromArchiving',
      'getDebLocation',
      'graph',
      'installFromArchive',
      'isPublished',
      'isV1Greater',
      'listIndexPackages',
      'moveArchive',
      'removeSources',
      'setSelection',
      'show',
      'syncRepository',
      '_archiving',
      '_moveToArchiving',
      '_syncRepository'
    );
  }

  getArchivesPath(repositoryPath, distribution) {
    return path.join(path.dirname(repositoryPath), 'wpkg@ver', distribution);
  }

  /**
   * Retrieve a list of packages available in a repository accordingly to filters.
   *
   * @yields
   * @param {string[]} repositoryPaths - Source repositories.
   * @param {string} arch - Architecture.
   * @param {object} filters - Strings or regexps (in an object).
   * @param {object} options - Provide greater: true if you want only the >
   * @returns {object} list of packages.
   */
  *listIndexPackages(repositoryPaths, arch, filters, options) {
    const list = {};

    for (const repositoryPath of repositoryPaths) {
      if (!fs.existsSync(repositoryPath)) {
        continue;
      }

      const _list = {};
      const wpkg = new WpkgBin(this._resp);
      yield wpkg.listIndexPackages(
        repositoryPath,
        arch,
        filters,
        _list,
        options
      );
      list[repositoryPath] = _list;
    }

    return list;
  }

  /**
   * Look in the repository if a specific package exists.
   *
   * @param {string} packageName - Package name.
   * @param {string} packageVersion - Package version.
   * @param {string} [archRoot] - Architecture for the admin dir.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [repositoryPath] - Path on the repository (null for default).
   * @param {callback} callback - Async callback.
   */
  _lookForPackage(
    packageName,
    packageVersion,
    archRoot,
    distribution,
    repositoryPath,
    callback
  ) {
    const repository =
      repositoryPath || xPacman.getDebRoot(distribution, this._resp);

    const repositories = [repository];
    if (repository !== this._xcraftConfig.pkgDebRoot) {
      repositories.push(this._xcraftConfig.pkgDebRoot);
    }

    if (!distribution) {
      distribution = this._pacmanConfig.pkgToolchainRepository;
    }
    distribution = distribution.replace(/\/$/, '');

    if (!archRoot) {
      archRoot = getToolchainArch();
    }

    const filters = {
      distrib: new RegExp(`(${distribution.replace('+', '\\+')}|sources)`),
      name: packageName,
      version: packageVersion,
      arch: new RegExp('(' + archRoot + '|all)'),
    };

    /* wpkg is able to install a package just by its name. But it's not possible
     * in this case to specify for example a version. And there is a regression
     * with the new way. Then we must look in the repository index file if
     * the package exists and in order to retrieve the full package name.
     */
    const op = {greater: true};
    this.listIndexPackages(repositories, archRoot, filters, op, (err, list) => {
      if (err) {
        callback(err);
        return;
      }

      let _repository;
      const exists = repositories.some((repository) => {
        _repository = repository;
        return list[repository] && list[repository][packageName];
      });

      if (!exists) {
        this._resp.log.warn('the package %s is unavailable', packageName);
        callback('package not found');
        return;
      }

      /* We have found the package, then we can build the full path and install
       * this one to the target root.
       */
      const deb = list[_repository][packageName];
      deb.file = path.join(_repository, deb.file);
      deb.repository = _repository;
      deb.distribution = distribution;
      try {
        const hashFile = deb.file + '.md5sum';
        deb.hash = fs.readFileSync(hashFile).toString().trim();
      } catch (ex) {
        /* ignore */
      }
      callback(null, deb);
    });
  }

  static _baseVersion(v) {
    return v.replace(/-[^-]*/, '');
  }

  *copyFromArchiving(packageName, arch, version, distribution) {
    const isSrc = packageName.endsWith('-src');
    const architecture = isSrc ? '' : arch;
    const outDistrib = isSrc ? 'sources/' : distribution;
    const archiveDistrib =
      packageName.endsWith('-src') && distribution.indexOf('+') === -1
        ? 'sources/'
        : distribution;
    let file = `${packageName}_${version}`;
    if (architecture) {
      file += `_${architecture}`;
    }
    file += '.deb';

    const archiveRepository = path.join(
      this.getArchivesPath(this._xcraftConfig.pkgDebRoot, archiveDistrib),
      packageName,
      version
    );
    const archivePackage = path.join(archiveRepository, file);
    const outputRepository = xPacman.getDebRoot(outDistrib, this._resp);
    const outputPackage = path.join(outputRepository, outDistrib, file);

    xFs.cp(archivePackage, outputPackage);
    try {
      xFs.cp(archivePackage + '.md5sum', outputPackage + '.md5sum');
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }

    yield this._syncRepository(outputRepository);
  }

  *_moveToArchiving(wpkg, packagesPath, archivesPath, deb, backLink = false) {
    const tryfs = (action, ...args) => {
      xFs[action](...args);
      try {
        xFs[action](...args.map((file) => file + '.md5sum'));
      } catch (ex) {
        if (ex.code !== 'ENOENT') {
          throw ex;
        }
      }
    };

    const archivePkgPath = path.join(archivesPath, deb.name);
    const archiveVerPath = path.join(archivePkgPath, deb.version);
    const src = path.join(packagesPath, deb.file);
    const dst = path.join(archiveVerPath, deb.file);

    if (fs.existsSync(dst)) {
      let md5sumSrc;
      let md5sumDst;

      if (fs.existsSync(src + '.md5sum')) {
        md5sumSrc = xFs.fse.readFileSync(src + '.md5sum', 'utf8');
      }
      if (fs.existsSync(dst + '.md5sum')) {
        md5sumDst = xFs.fse.readFileSync(dst + '.md5sum', 'utf8');
      }

      if (md5sumSrc === md5sumDst) {
        if (!backLink) {
          tryfs('rm', src);
        }
        return;
      }

      this._resp.log.warn(
        `replace ${dst} by a new wpkg build with the same version`
      );
    }

    tryfs(backLink ? 'cp' : 'mv', src, dst);
    yield wpkg.createIndex(archiveVerPath, this._pacmanConfig.pkgIndex);

    /* Update pacman package index for the list of versions */
    const indexJson = path.join(archivePkgPath, 'index.json');
    let _list = {};
    try {
      _list = xFs.fse.readJSONSync(indexJson);
      /* Remove versions that no longer exists */
      for (const entry of Object.values(_list)) {
        if (!entry.versions) {
          continue;
        }
        const versions = [];
        for (const version of entry.versions) {
          if (xFs.fse.existsSync(path.join(archivePkgPath, version))) {
            versions.push(version);
          }
        }
        entry.versions = versions;
      }
    } catch {
      /* Use a new empty file */
    }
    const baseVersions = {};
    xFs.lsdir(archivePkgPath).reduce((list, version) => {
      const base = Wpkg._baseVersion(version);
      if (!list[base]) {
        list[base] = {latest: '', versions: []};
      } else if (!list[base].versions || !baseVersions[base]) {
        list[base].versions = [];
        baseVersions[base] = true;
      }
      list[base].versions.push(version);
      return list;
    }, _list);

    const baseVersion = Wpkg._baseVersion(deb.version);
    _list[baseVersion].latest = yield* maxVersion(_list[baseVersion].versions);
    _list.latest = yield* maxVersion(
      Object.keys(_list).filter((key) => key !== 'latest')
    );

    xFs.fse.writeJSONSync(indexJson, _list, {spaces: 2});
  }

  *_archiving(wpkg, repositoryPath, distributions, next) {
    const archRoot = getToolchainArch();
    const indexList = yield this.listIndexPackages(
      [repositoryPath],
      archRoot,
      null,
      null,
      next
    );

    for (const distribution of distributions) {
      const archivesPath = this.getArchivesPath(repositoryPath, distribution);
      const packagesPath = path.join(repositoryPath, distribution);
      const list = xFs
        .ls(packagesPath, /\.deb$/)
        .map((pkg) => {
          const m = pkg.match(/([^ _]*)_([^ _]*)(?:_([^ _]*))?\.deb$/);
          return {
            distrib: distribution,
            name: m[1],
            version: m[2],
            arch: m[3],
            file: pkg,
            previous: undefined,
          };
        })
        .filter((pkg) => !pkg.name.endsWith('-stub'))
        .reduce((list, pkg) => {
          if (!list[pkg.name]) {
            list[pkg.name] = [];
          }

          list[pkg.name].push(pkg);
          return list;
        }, {});

      for (const name of Object.keys(list)) {
        /* Extract the specific distribution if necessary */
        const getFinalArchivesPath = (deb) => {
          let specificDistrib;
          if (indexList[repositoryPath]?.[name]?.[deb.version]) {
            specificDistrib = indexList[repositoryPath][name][
              deb.version
            ].ctrl.Distribution.split(' ').find(
              (distrib) => distrib.indexOf('+') !== -1
            );
          }
          return specificDistrib
            ? this.getArchivesPath(repositoryPath, specificDistrib)
            : archivesPath;
        };

        const debs = list[name];

        if (debs.length > 1) {
          let toCheck = debs[0];
          for (let i = 1; i < debs.length; ++i) {
            let toAr;

            const comp = yield debversion(debs[i].version, toCheck.version);
            if (comp > 0) {
              toAr = toCheck;
              toCheck = debs[i];
            } else {
              toAr = debs[i];
            }

            toAr.previous = true;
            yield this._moveToArchiving(
              wpkg,
              packagesPath,
              getFinalArchivesPath(toAr),
              toAr,
              false
            );
          }
        }

        const latest = debs.find((deb) => !deb.previous);
        if (!latest) {
          throw new Error(
            `At least one version of ${name} must exist in the main repository`
          );
        }

        yield this._moveToArchiving(
          wpkg,
          packagesPath,
          getFinalArchivesPath(latest),
          latest,
          true
        );
      }
    }
  }

  getArchiveLatestVersion(packageName, distribution) {
    const repositoryPath = xPacman.getDebRoot(distribution, this._resp);
    const archiveDistrib =
      packageName.endsWith('-src') && distribution.indexOf('+') === -1
        ? 'sources/'
        : distribution;
    const archivesPath = this.getArchivesPath(repositoryPath, archiveDistrib);
    const indexJson = path.join(archivesPath, packageName, 'index.json');

    try {
      const index = xFs.fse.readJSONSync(indexJson);
      return index?.[index?.latest]?.latest;
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
  }

  listArchiveVersions(packageName, distribution) {
    const repositoryPath = xPacman.getDebRoot(distribution, this._resp);
    const archivesPath = this.getArchivesPath(repositoryPath, distribution);
    const indexJson = path.join(archivesPath, packageName, 'index.json');

    try {
      const index = xFs.fse.readJSONSync(indexJson);
      let list = [];
      for (const key of Object.keys(index).filter((v) => v !== 'latest')) {
        list = list.concat(index[key].versions);
      }
      return list;
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
      return [];
    }
  }

  *moveArchive(name, version, distribution, destinationDir) {
    const repositoryPath = xPacman.getDebRoot(distribution, this._resp);
    const archivesPath = this.getArchivesPath(repositoryPath, distribution);
    const archivePkgPath = path.join(archivesPath, name);
    const archiveVerPath = path.join(archivePkgPath, version);

    const indexJson = path.join(archivesPath, name, 'index.json');
    const index = xFs.fse.readJSONSync(indexJson);
    const baseVersion = Wpkg._baseVersion(version);

    if (!index[baseVersion]) {
      return;
    }

    const it = index[baseVersion].versions.indexOf(version);
    if (it === -1) {
      return;
    }

    /* The very last */
    const isLatest = baseVersion === index.latest;
    /* The last for this base version */
    const isBaseLatest = version === index[baseVersion].latest;

    index[baseVersion].versions.splice(it, 1);
    if (isBaseLatest) {
      if (isLatest) {
        this._resp.log.warn(
          `${name} ${version} cannot be moved because it's the last one`
        );
        return;
      }
      const length = index[baseVersion].versions.length;
      if (length === 0) {
        delete index[baseVersion];
      } else {
        const wpkg = new WpkgBin(this._resp);
        index[baseVersion].latest = yield* maxVersion(
          index[baseVersion].versions
        );
      }
    }

    try {
      xFs.mv(archiveVerPath, path.join(destinationDir, name, version));
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
    xFs.fse.writeJSONSync(indexJson, index, {spaces: 2});
  }

  *_syncRepository(repositoryPath) {
    const wpkg = new WpkgBin(this._resp);
    try {
      const distributions = xFs.lsdir(repositoryPath);
      /* Detect potential new packages */
      yield wpkg.createIndex(repositoryPath, this._pacmanConfig.pkgIndex);
      yield this._archiving(wpkg, repositoryPath, distributions);
      /* Update after the archiving of some packages */
      yield wpkg.createIndex(repositoryPath, this._pacmanConfig.pkgIndex);
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
  }

  _build(packagePath, isSource, outputRepository, distribution, callback) {
    const repositoryPath =
      outputRepository || xPacman.getDebRoot(distribution, this._resp);
    const pathObj = packagePath.split(path.sep);

    /* Retrieve the architecture which is in the packagePath. */
    const arch = pathObj[pathObj.length - 2];
    const currentDir = process.cwd();

    const wpkg = new WpkgBin(this._resp);

    const wpkgCallback = (err) => {
      process.chdir(currentDir);

      if (err) {
        callback(err);
        return;
      }

      /* We create or update the index with our new package. */
      this._syncRepository(repositoryPath, callback);
    };

    if (isSource) {
      process.chdir(packagePath);
      wpkg.buildSrc(repositoryPath, distribution, wpkgCallback);
    } else {
      wpkg.build(repositoryPath, packagePath, arch, distribution, wpkgCallback);
    }
  }

  /**
   * Build a new standard package.
   *
   * @param {string} packagePath - Source package location.
   * @param {string} [outputRepository] - null for default.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  build(packagePath, outputRepository, distribution, callback) {
    this._build(packagePath, false, outputRepository, distribution, callback);
  }

  /**
   * Build a new source package.
   *
   * @param {string} packagePath - Source package location.
   * @param {string} [outputRepository] - null for default.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  buildSrc(packagePath, outputRepository, distribution, callback) {
    this._build(packagePath, true, outputRepository, distribution, callback);
  }

  /**
   * Build a new binary package from a source package.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [repository] - Source repository (null for default).
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  buildFromSrc(packageName, arch, repository, distribution, callback) {
    if (!repository) {
      repository = xPacman.getDebRoot(distribution, this._resp);
    }

    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot, {
      PEON_DISTRIBUTION: distribution || '',
    });

    const wpkgCallback = (err) => {
      if (err) {
        callback(err);
        return;
      }

      /* We use getDebRoot because 'null' is passed to both wpkg.build calls. */
      this._syncRepository(
        xPacman.getDebRoot(distribution, this._resp),
        callback
      );
    };

    /* Without packageName we consider the build of all source packages. */
    if (!packageName) {
      const srcRepository = path.join(repository, 'sources');

      if (!fs.existsSync(srcRepository)) {
        callback('nothing to build');
        return;
      }

      this._resp.log.verb(`Repository ${srcRepository}:`);
      const files = fs.readdirSync(srcRepository);
      files
        .filter((file) => file.endsWith('.deb'))
        .forEach((file) => this._resp.log.verb(`→ ${file}`));

      wpkg.build(null, repository, arch, distribution, wpkgCallback);
      return;
    }

    this._lookForPackage(
      packageName,
      null,
      arch,
      distribution,
      null,
      (err, deb) => {
        if (err) {
          callback(err);
          return;
        }

        wpkg.build(null, deb.file, arch, distribution, wpkgCallback);
      }
    );
  }

  /**
   * List files of a package (data).
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {callback} callback - Async callback.
   */
  listFiles(packageName, arch, callback) {
    const list = [];

    const wpkg = new WpkgBin(this._resp);

    wpkg.listFiles(packageName, arch, list, (err) => {
      callback(err, list);
    });
  }

  /**
   * List root packages (data).
   *
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [pattern] - Glob Unix Shell Pattern for filtering.
   * @param {callback} callback - Async callback.
   */
  list(arch, distribution, pattern, callback) {
    const list = [];
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);

    wpkg.list(arch, pattern, list, (err) => {
      callback(err, list);
    });
  }

  /**
   * Search files in installed packages.
   *
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [pattern] - Glob Unix Shell Pattern for searching.
   * @param {callback} callback - Async callback.
   */
  search(arch, distribution, pattern, callback) {
    const list = [];
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);

    wpkg.search(arch, pattern, list, (err) => {
      callback(err, list);
    });
  }

  /**
   * Unlock the core database.
   *
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  unlock(arch, distribution, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);
    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.unlock(arch, callback);
  }

  /**
   * Install a package with its dependencies.
   *
   * The full local path is computed accordingly by using the local repository.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [targetRoot] - For production root (null for devroot).
   * @param {boolean} [reinstall] - Reinstall if already installed.
   * @param {callback} callback - Async callback.
   */
  install(packageName, arch, distribution, targetRoot, reinstall, callback) {
    this._lookForPackage(
      packageName,
      null,
      arch,
      distribution,
      null,
      (err, deb) => {
        if (err) {
          callback(err);
          return;
        }

        if (!targetRoot) {
          targetRoot = xPacman.getTargetRoot(distribution, this._resp);
        }

        const wpkg = new WpkgBin(this._resp, targetRoot);
        wpkg.install(deb.file, arch, distribution, reinstall, callback);
      }
    );
  }

  /**
   * Install a package with its dependencies (only with the package name).
   *
   * This function is used in the case of external repositories. It should be
   * possible to use _lookForPackage like with the install method but the
   * http support is not implemented.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [targetRoot] - For production root (null for devroot).
   * @param {boolean} [reinstall] - Reinstall if already installed.
   * @param {callback} callback - Async callback.
   */
  installByName(
    packageName,
    arch,
    distribution,
    targetRoot,
    reinstall,
    callback
  ) {
    if (!targetRoot) {
      targetRoot = xPacman.getTargetRoot(distribution, this._resp);
    }

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.install(packageName, arch, distribution, reinstall, callback);
  }

  /**
   * Install a package from the archive directories.
   *
   * @yields
   * @param {string} packageName - Package file location.
   * @param {string} arch - Architecture.
   * @param {string} distribution - A specific distribution or null for default.
   * @param {string} version - Version.
   * @param {string} targetRoot - For production root (null for devroot).
   * @param {boolean} reinstall - Reinstall if already installed.
   * @param {next} next - Watt's callback.
   */
  *installFromArchive(
    packageName,
    arch,
    distribution,
    version,
    targetRoot,
    reinstall,
    next
  ) {
    if (!targetRoot) {
      targetRoot = xPacman.getTargetRoot(distribution, this._resp);
    }

    const deb = yield this.getDebLocation(
      packageName,
      arch,
      version,
      distribution
    );

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.install(deb.file, arch, deb.distribution, reinstall, next);
  }

  /**
   * Test if a package is already installed.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  isInstalled(packageName, arch, distribution, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);

    wpkg.isInstalled(packageName, arch, (err, code) => {
      if (err) {
        callback(err);
        return;
      }

      callback(null, !code);
    });
  }

  /**
   * Get some fields of a package.
   *
   * If the result is null, then the package is not available.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  fields(packageName, arch, distribution, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.fields(packageName, arch, callback);
  }

  /**
   * Get package deb location.
   *
   * If the result is null, then the package is not available.
   *
   * @yields
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [version] - Version
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} next - Watt's callback.
   * @returns {*} the package location.
   */
  *getDebLocation(packageName, arch, version, distribution, next) {
    let repository = null;

    if (version) {
      const xEtc = require('xcraft-core-etc')();
      const xConfig = xEtc.load('xcraft');

      if (!distribution) {
        distribution = this._pacmanConfig.pkgToolchainRepository;
      }

      const archiveDistrib =
        packageName.endsWith('-src') && distribution.indexOf('+') === -1
          ? 'sources/'
          : distribution;

      repository = path.join(
        this.getArchivesPath(xConfig.pkgDebRoot, archiveDistrib),
        packageName,
        version
      );
    }

    const deb = yield this._lookForPackage(
      packageName,
      version,
      arch,
      distribution,
      repository,
      next
    );

    if (version && deb.repository !== repository) {
      this._resp.log.warn(
        `package ${packageName} not found in ${distribution} for the version ${version}`
      );
      throw 'package not found';
    }
    return deb;
  }

  /**
   * Get fields of a package as a deep JSON.
   *
   * If the result is null, then the package is not available.
   *
   * @yields
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [version] - Version
   * @param {string} [distribution] - A specific distribution or null for default.
   * @returns {*} the Debian package definition.
   */
  *show(packageName, arch, version, distribution) {
    const deb = yield this.getDebLocation(
      packageName,
      arch,
      version,
      distribution
    );

    if (deb.hash) {
      if (Wpkg.#showCache.has(deb.hash)) {
        return Wpkg.#showCache.get(deb.hash);
      }
    }

    const wpkg = new WpkgBin(this._resp, null);
    const def = yield wpkg.show(deb.file, deb.distribution);
    Wpkg.#showCache.set(deb.hash, def);
    return def;
  }

  /**
   * Remove a package.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {boolean} [recursive] - Remove deps recursively.
   * @param {callback} callback - Async callback.
   */
  remove(packageName, arch, distribution, recursive, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.remove(packageName, arch, recursive, callback);
  }

  /**
   * Autoremove implicit and no longer used packages
   *
   * @yields
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   */
  *autoremove(arch, distribution) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    yield wpkg.autoremove(arch);
  }

  /**
   * @yields
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} selection - auto, normal, hold, reject
   * @param {string} [distribution] - A specific distribution or null for default.
   */
  *setSelection(packageName, arch, selection, distribution) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    yield wpkg.setSelection(packageName, arch, selection);
  }

  /**
   * Create the administration directory in the target root.
   * The target root is the destination where are installed the packages.
   *
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {callback} callback - Async callback.
   */
  createAdmindir(arch, distribution, targetRoot, callback) {
    const xFs = require('xcraft-core-fs');
    const xPh = require('xcraft-core-placeholder');

    /* This control file is used in order to create a new admin directory. */
    const fileIn = path.join(__dirname, './templates/admindir.control');
    const fileOut = path.join(this._xcraftConfig.tempRoot, 'control');

    if (!distribution) {
      distribution = this._pacmanConfig.pkgToolchainRepository;
    }

    if (!distribution.endsWith('/')) {
      distribution += '/';
    }

    const ph = new xPh.Placeholder();
    ph.set('ARCHITECTURE', arch)
      .set('MAINTAINER.NAME', 'Xcraft')
      .set('MAINTAINER.EMAIL', 'xcraft@xcraft.ch')
      .set('DISTRIBUTION', distribution)
      .injectFile('ADMINDIR', fileIn, fileOut);

    /* Create the target directory. */
    xFs.mkdir(path.join(targetRoot || this._xcraftConfig.pkgTargetRoot, arch));

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.createAdmindir(fileOut, arch, callback);
  }

  /**
   * Add one or more global hooks in the admindir.
   *
   * An hook must be a shell or batch script.
   *
   * @param {string[]} hooks - List of scripts paths.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} callback - Async callback.
   */
  addHooks(hooks, arch, distribution, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.addHooks(hooks, arch, callback);
  }

  /**
   * Add a new source in the target installation.
   *
   * A source is needed in order to upgrade the packages in the target root
   * accordingly to the versions in the repository referenced in the source.
   *
   * @yields
   * @param {string} sourcePath - The new APT source entry to add.
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] - For production root (null for devroot).
   * @param {callback} next - watt.
   */
  *addSources(sourcePath, arch, targetRoot, next) {
    if (!targetRoot) {
      targetRoot = this._xcraftConfig.pkgTargetRoot;
    }

    const sourcesList = path.join(
      targetRoot,
      arch,
      'var/lib/wpkg/core/sources.list'
    );
    let sources = '';
    try {
      sources = fs.readFileSync(sourcesList, 'utf8');
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }

    /* We don't use listSources anymore because it uses the database lock */
    // const list = [];
    // yield wpkg.listSources(arch, list, false, next);
    //
    // /* The list array is populated by listSources. */
    // if (list.indexOf(sourcePath) >= 0) {
    //   return; /* already in the sources.list */
    // }

    const list = sources.split(/\n/).map((row) => row.trim());
    if (list.indexOf(sourcePath) >= 0) {
      return; /* already in the sources.list */
    }

    const wpkg = new WpkgBin(this._resp, targetRoot);
    yield wpkg.addSources(sourcePath, arch, next);
  }

  /**
   * Remove a source from the target installation.
   *
   * @yields
   * @param {string} sourcePath - The APT source entry to remove.
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {callback} next - watt.
   */
  *removeSources(sourcePath, arch, targetRoot, next) {
    if (!targetRoot) {
      targetRoot = this._xcraftConfig.pkgTargetRoot;
    }

    const sourcesList = path.join(
      targetRoot,
      arch,
      'var/lib/wpkg/core/sources.list'
    );
    const sources = fs.readFileSync(sourcesList, 'utf8');

    /* We don't use listSources anymore because it uses the database lock */
    // let list = [];
    // yield wpkg.listSources(arch, list, true);
    //
    // const _list = {};
    // list.forEach((source) => {
    //   const exploded = source.split('. ');
    //   const it = parseInt(exploded[0]);
    //   if (!Number.isNaN(it)) {
    //     const it = exploded.shift();
    //   }
    //     _list[exploded.join('. ')] = parseInt(it) - 1;
    // });

    const list = sources.split(/\n/).map((row) => row.trim());
    const it = list.indexOf(sourcePath) - 1;
    if (it < 0) {
      return;
    }

    const wpkg = new WpkgBin(this._resp, targetRoot);
    yield wpkg.removeSources(it, arch, next);
  }

  /**
   * Update the list of available packages from the repository.
   *
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {callback} callback - Async callback.
   */
  update(arch, targetRoot, callback) {
    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.update(arch, callback);
  }

  /**
   * Upgrade the packages in the target root.
   *
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {callback} callback - Async callback.
   */
  upgrade(arch, targetRoot, callback) {
    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.upgrade(arch, callback);
  }

  /**
   * Publish a package in a specified repository.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} inputRepository - Source repository.
   * @param {string} outputRepository - Destination repository.
   * @param {string} distribution - Distribution name.
   * @param {callback} callback - Async callback.
   */
  publish(
    packageName,
    arch,
    inputRepository,
    outputRepository,
    distribution,
    callback
  ) {
    if (!outputRepository) {
      outputRepository = xPacman.getDebRoot(distribution, this._resp);
    }

    this._lookForPackage(
      packageName,
      null,
      arch,
      distribution,
      inputRepository,
      (err, deb) => {
        if (err) {
          callback(err);
          return;
        }

        const dest = path.join(outputRepository, distribution);
        try {
          xFs.mkdir(dest);
          xFs.cp(deb.file, path.join(dest, path.basename(deb.file)));
        } catch (ex) {
          callback(ex.stack);
          return;
        }

        try {
          const md5sum = `${deb.file}.md5sum`;
          xFs.cp(md5sum, path.join(dest, path.basename(md5sum)));
        } catch (ex) {
          /* ignore */
        }

        /* We create or update the index with our new package. */
        this._syncRepository(outputRepository, callback);
      }
    );
  }

  /**
   * Unpublish a package from a specified repository.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} repository - Source repository.
   * @param {string} distribution - Distribution name.
   * @param {boolean} updateIndex - True to call createIndex (slow).
   * @param {callback} callback - Async callback.
   */
  unpublish(
    packageName,
    arch,
    repository,
    distribution,
    updateIndex,
    callback
  ) {
    if (!repository) {
      repository = xPacman.getDebRoot(distribution, this._resp);
    }

    this._lookForPackage(
      packageName,
      null,
      arch,
      distribution,
      repository,
      (err, deb) => {
        if (err) {
          callback(err);
          return;
        }

        try {
          xFs.rm(deb.file);
        } catch (ex) {
          callback(ex.stack);
          return;
        }

        try {
          xFs.rm(`${deb.file}.md5sum`);
        } catch (ex) {
          /* ignore errors */
        }

        if (updateIndex) {
          /* We create or update the index with our new package(s). */
          this._syncRepository(repository, callback);
        } else {
          callback();
        }
      }
    );
  }

  /**
   * Check if a package is already published.
   *
   * @yields
   * @param {string} packageName - Package name.
   * @param {string} packageVersion - Package version.
   * @param {string} [arch] - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [repositoryPath] - Path on the repository (or null).
   * @param {callback} next - Watt's callback.
   * @returns {*} the debian package info.
   */
  *isPublished(
    packageName,
    packageVersion,
    arch,
    distribution,
    repositoryPath,
    next
  ) {
    return yield this._lookForPackage(
      packageName,
      packageVersion,
      arch,
      distribution,
      repositoryPath,
      (err, deb) => {
        if (err) {
          this._resp.log.warn(err);
          next(null, false);
          return;
        }

        next(null, deb);
      }
    );
  }

  targetExists(distribution) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);
    return xFs.fse.existsSync(targetRoot);
  }

  /**
   * Synchronize the repository with the archives repositories.
   *
   * @yields
   * @param {string} distribution - A specific distribution or null for default.
   * @param {callback} next - Watt's callback.
   */
  *syncRepository(distribution, next) {
    yield this._syncRepository(
      xPacman.getDebRoot(distribution, this._resp),
      next
    );
  }

  /**
   * Generate a graph for a list of packages.
   *
   * @yields
   * @param {string} packageNames - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {callback} next - Watt's callback.
   */
  *graph(packageNames, arch, distribution, next) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);

    const debs = [];
    for (const packageName of packageNames) {
      const distribs = [distribution, null];
      for (const distrib of distribs) {
        try {
          const {file} = yield this._lookForPackage(
            packageName,
            null,
            arch,
            distrib,
            null,
            next
          );
          debs.push(file);
          break;
        } catch (ex) {
          /* Ignore, we try with the next distribution */
        }
      }
    }

    yield wpkg.graph(debs, arch);
  }

  *isV1Greater(v1, v2) {
    const wpkg = new WpkgBin(this._resp);
    return yield wpkg.isV1Greater(v1, v2);
  }
}

module.exports = (resp) => new Wpkg(resp);
