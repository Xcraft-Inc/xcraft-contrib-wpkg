'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');

const xCMake = require('xcraft-contrib-bootcmake');
const xEnv = require('xcraft-core-env');
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

    watt.wrapAll(this, 'listIndexPackages');
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

  _build(packagePath, isSource, outputRepository, distribution, callback) {
    const repositoryPath =
      outputRepository || xPacman.getDebRoot(distribution, this._resp);
    const pathObj = packagePath.split(path.sep);

    /* Retrieve the architecture which is in the packagePath. */
    const arch = pathObj[pathObj.length - 2];
    const currentDir = process.cwd();
    let envPath = [];

    const wpkg = new WpkgBin(this._resp);

    const wpkgCallback = (err) => {
      for (const p of envPath) {
        xEnv.var.path.insert(p.index, p.location);
      }

      process.chdir(currentDir);

      if (err) {
        callback(err);
        return;
      }

      const wpkg = new WpkgBin(this._resp);

      /* We create or update the index with our new package. */
      wpkg.createIndex(repositoryPath, this._pacmanConfig.pkgIndex, callback);
    };

    if (isSource) {
      process.chdir(packagePath);
      envPath = xCMake.stripShForMinGW();
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
    const envPath = xCMake.stripShForMinGW();

    if (!repository) {
      repository = xPacman.getDebRoot(distribution, this._resp);
    }

    const targetRoot = xPacman.getTargetRoot(distribution, this._resp);

    const wpkg = new WpkgBin(this._resp, targetRoot, {
      PEON_DISTRIBUTION: distribution || '',
    });

    const wpkgCallback = (err) => {
      for (const p of envPath) {
        xEnv.var.path.insert(p.index, p.location);
      }
      callback(err);
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
   * Install a package with its dependencies.
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
   * A source is needed in order to upgrade the packages in the target root
   * accordingly to the versions in the repository referenced in the source.
   *
   * @param {string} sourcePath - The new APT source entry to add.
   * @param {string} arch - Architecture.
   * @param {string} [targetRoot] -  For production root (null for devroot).
   * @param {function(err, results)} callback - Async callback.
   */
  addSources(sourcePath, arch, targetRoot, callback) {
    const async = require('async');

    if (!targetRoot) {
      targetRoot = this._xcraftConfig.pkgTargetRoot;
    }

    async.auto(
      {
        checkSources: (callback) => {
          const sourcesList = path.join(
            targetRoot,
            arch,
            'var/lib/wpkg/core/sources.list'
          );
          const exists = fs.existsSync(sourcesList);
          callback(null, exists);
        },

        listSources: [
          'checkSources',
          (callback, results) => {
            const list = [];

            if (!results.checkSources) {
              callback(null, list);
              return;
            }

            const wpkg = new WpkgBin(this._resp, targetRoot);
            wpkg.listSources(arch, list, (err) => {
              callback(err, list);
            });
          },
        ],

        addSources: [
          'listSources',
          (callback, results) => {
            /* The list array is populated by listSources. */
            if (results.listSources.indexOf(sourcePath) >= 0) {
              callback();
              return; /* already in the sources.list */
            }

            const wpkg = new WpkgBin(this._resp, targetRoot);
            wpkg.addSources(sourcePath, arch, callback);
          },
        ],
      },
      callback
    );
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

        const wpkg = new WpkgBin(this._resp);
        /* We create or update the index with our new package. */
        wpkg.createIndex(
          outputRepository,
          this._pacmanConfig.pkgIndex,
          callback
        );
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
          const wpkg = new WpkgBin(this._resp);
          /* We create or update the index with our new package(s). */
          wpkg.createIndex(repository, this._pacmanConfig.pkgIndex, callback);
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
}

module.exports = (resp) => new Wpkg(resp);
