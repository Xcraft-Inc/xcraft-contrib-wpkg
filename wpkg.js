'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');

const xFs = require('xcraft-core-fs');
const xPacman = require('xcraft-contrib-pacman');

const WpkgBin = require('./lib/bin.js');

class MapLimit extends Map {
  constructor(max) {
    super();
    this._max = max;
  }

  set(key, value) {
    while (this.size >= this._max) {
      const it = this.entries();
      this.delete(it.next().value[0]);
    }
    super.set(key, value);
  }
}

class Wpkg {
  constructor(resp) {
    this._resp = resp;

    const xEtc = require('xcraft-core-etc')(null, this._resp);
    this._xcraftConfig = xEtc.load('xcraft');
    this._pacmanConfig = xEtc.load('xcraft-contrib-pacman');
    this._cache = new MapLimit(100);

    watt.wrapAll(
      this,
      'graph',
      'listIndexPackages',
      'addSources',
      'removeSources',
      'isV1Greater',
      '_moveToArchiving',
      '_archiving',
      '_syncRepository'
    );
  }

  /**
   * Retrieve a list of packages available in a repository accordingly to filters.
   *
   * @param {string[]} repositoryPaths - Source repositories.
   * @param {string} arch - Architecture.
   * @param {Object} filters - Strings or regexps (in an object).
   * @returns {Object} list of packages.
   */
  *listIndexPackages(repositoryPaths, arch, filters) {
    const list = {};

    for (const repositoryPath of repositoryPaths) {
      if (!fs.existsSync(repositoryPath)) {
        continue;
      }

      const _list = {};
      const wpkg = new WpkgBin(this._resp);
      yield wpkg.listIndexPackages(repositoryPath, arch, filters, _list);
      list[repositoryPath] = _list;
    }

    return list;
  }

  /**
   * Look in the repository if a specific package exists.
   *
   * @param {string} packageName - Package name.
   * @param {string} packageVersion - Package version.
   * @param {string} archRoot - Architecture for the admin dir.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [repositoryPath] - Path on the repository (null for default).
   * @param {function(err, deb)} callback - Async callback.
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

    const filters = {
      distrib: new RegExp(`(${distribution}|sources)`),
      name: packageName,
      version: packageVersion,
      arch: new RegExp('(' + archRoot + '|all)'),
    };

    /* wpkg is able to install a package just by its name. But it's not possible
     * in this case to specify for example a version. And there is a regression
     * with the new way. Then we must look in the repository index file if
     * the package exists and in order to retrieve the full package name.
     */
    this.listIndexPackages(repositories, archRoot, filters, (err, list) => {
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
      try {
        const hashFile = deb.file + '.md5sum';
        deb.hash = fs.readFileSync(hashFile).toString().trim();
      } catch (ex) {
        /* ignore */
      }
      callback(null, deb);
    });
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

    const archivePath = path.join(archivesPath, deb.name, deb.version);
    const src = path.join(packagesPath, deb.file);
    const dst = path.join(archivePath, deb.file);

    if (fs.existsSync(dst)) {
      if (!backLink) {
        tryfs('rm', src);
      }
      return;
    }

    tryfs(backLink ? 'cp' : 'mv', src, dst);
    yield wpkg.createIndex(archivePath, this._pacmanConfig.pkgIndex);
  }

  *_archiving(wpkg, repositoryPath, distributions) {
    for (const distribution of distributions) {
      const archivesPath = path.join(
        path.dirname(repositoryPath),
        'wpkg@ver',
        distribution
      );
      const packagesPath = path.join(repositoryPath, distribution);
      const packages = xFs.ls(packagesPath, /\.deb$/);
      const list = {};

      for (const pkg of packages) {
        const result = pkg.match(/([^ _]*)_([^ _]*)(?:_([^ _]*))?\.deb$/);
        const deb = {
          distrib: distribution,
          name: result[1],
          version: result[2],
          arch: result[3],
          file: pkg,
          previous: undefined,
        };
        if (!list[deb.name]) {
          list[deb.name] = [];
        }

        list[deb.name].push(deb);
      }

      for (const name of Object.keys(list)) {
        const debs = list[name];

        if (debs.length > 1) {
          let toCheck = debs[0];
          for (let i = 1; i < debs.length; ++i) {
            let toAr;

            if (yield wpkg.isV1Greater(debs[i].version, toCheck.version)) {
              toAr = toCheck;
              toCheck = debs[i];
            } else {
              toAr = debs[i];
            }

            toAr.previous = true;
            yield this._moveToArchiving(
              wpkg,
              packagesPath,
              archivesPath,
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
          archivesPath,
          latest,
          true
        );
      }
    }
  }

  *_syncRepository(repositoryPath) {
    const wpkg = new WpkgBin(this._resp);
    const distributions = xFs.lsdir(repositoryPath);
    yield this._archiving(wpkg, repositoryPath, distributions);
    return yield wpkg.createIndex(repositoryPath, this._pacmanConfig.pkgIndex);
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
      if (!fs.existsSync(path.join(repository, 'sources'))) {
        callback('nothing to build');
        return;
      }

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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * Test if a package is already installed.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
   */
  fields(packageName, arch, distribution, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.fields(packageName, arch, callback);
  }

  /**
   * Get fields of a package as a deep JSON.
   *
   * If the result is null, then the package is not available.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {function(err, results)} callback - Async callback.
   */
  show(packageName, arch, distribution, callback) {
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

        if (deb.hash) {
          if (this._cache.has(deb.hash)) {
            callback(null, this._cache.get(deb.hash));
            return;
          }
        }

        const wpkg = new WpkgBin(this._resp, null);
        wpkg.show(deb.file, (err, def) => {
          if (!err) {
            this._cache.set(deb.hash, def);
          }
          callback(err, def);
        });
      }
    );
  }

  /**
   * Remove a package.
   *
   * @param {string} packageName - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {boolean} [recursive] - Remove deps recursively.
   * @param {function(err, results)} callback - Async callback.
   */
  remove(packageName, arch, distribution, recursive, callback) {
    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot);
    wpkg.remove(packageName, arch, recursive, callback);
  }

  /**
   * Create the administration directory in the target root.
   * The target root is the destination where are installed the packages.
   *
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {string} sourcePath - The new APT source entry to add.
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] - For production root (null for devroot).
   * @param {function(err, results)} next - watt.
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
   * @param {string} sourcePath - The new APT source entry to add.
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {function(err, results)} next - watt.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {function(err, results)} callback - Async callback.
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
   * @param {string} packageName - Package name.
   * @param {string} packageVersion - Package version.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
   * @param {string} [repositoryPath] - Path on the repository (or null).
   * @param {function(err, results)} callback - Async callback.
   */
  isPublished(
    packageName,
    packageVersion,
    arch,
    distribution,
    repositoryPath,
    callback
  ) {
    this._lookForPackage(
      packageName,
      packageVersion,
      arch,
      distribution,
      repositoryPath,
      (err, deb) => {
        if (err) {
          this._resp.log.warn(err);
          callback(null, false);
          return;
        }

        callback(null, deb);
      }
    );
  }

  /**
   * Generate a graph for a list of packages.
   *
   * @param {string} packageNames - Package name.
   * @param {string} arch - Architecture.
   * @param {string} [distribution] - A specific distribution or null for default.
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
