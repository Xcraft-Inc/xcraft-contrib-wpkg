'use strict';

const path = require ('path');
const fs   = require ('fs');

const xCMake = require ('xcraft-contrib-bootcmake');
const xEnv   = require ('xcraft-core-env');
const xFs    = require ('xcraft-core-fs');

const WpkgBin = require ('./lib/bin.js');


class Wpkg {
  constructor (resp) {
    this._resp = resp;

    const xEtc = require ('xcraft-core-etc') (null, this._resp);
    this._xcraftConfig = xEtc.load ('xcraft');
    this._pacmanConfig = xEtc.load ('xcraft-contrib-pacman');
  }

  /**
   * Retrieve a list of packages available in a repository accordingly to filters.
   *
   * @param {string} repositoryPath
   * @param {string} arch
   * @param {Object} filters
   * @param {function(err, results)} callback
   */
  listIndexPackages (repositoryPath, arch, filters, callback) {
    var list = [];

    if (!fs.existsSync (repositoryPath)) {
      callback ('repository not found');
      return;
    }

    var wpkg = new WpkgBin (this._resp);

    wpkg.listIndexPackages (repositoryPath, arch, filters, list, (err) => {
      /* The list array is populated by listIndexPackages. */
      callback (err, list);
    });
  }

  /**
   * Look in the repository if a specific package exists.
   *
   * @param {string} packageName
   * @param {string} packageVersion
   * @param {string} archRoot - Architecture for the admin dir.
   * @param {string} repositoryPath - Path on the repository (null for default).
   * @param {function(err, deb)} callback
   */
  _lookForPackage (packageName, packageVersion, archRoot, repositoryPath, callback) {
    const repository = repositoryPath || this._xcraftConfig.pkgDebRoot;

    var filters = {
      name:    packageName,
      version: packageVersion,
      arch:    new RegExp ('(' + archRoot + '|all)')
    };

    /* wpkg is able to install a package just by its name. But it's not possible
     * in this case to specify for example a version. And there is a regression
     * with the new way. Then we must look in the repository index file if
     * the package exists and in order to retrieve the full package name.
     */
    this.listIndexPackages (repository, archRoot, filters, (err, list) => {
      if (err) {
        callback (err);
        return;
      }

      var debFile = list[packageName];
      if (!debFile) {
        this._resp.log.warn ('the package %s is unavailable', packageName);
        callback ('package not found');
        return;
      }

      /* We have found the package, then we can build the full path and install
      * this one to the target root.
      */
      debFile = path.join (repository, debFile);
      callback (null, debFile);
    });
  }

  _build (packagePath, isSource, distribution, outputRepository, callback) {
    const repositoryPath = outputRepository || this._xcraftConfig.pkgDebRoot;
    var pathObj = packagePath.split (path.sep);

    /* Retrieve the architecture which is in the packagePath. */
    var arch = pathObj[pathObj.length - 2];
    var currentDir = process.cwd ();
    let envPath = [];

    var wpkg = new WpkgBin (this._resp);

    const wpkgCallback = (err) => {
      for (const p of envPath) {
        xEnv.var.path.insert (p.index, p.location);
      }

      process.chdir (currentDir);

      if (err) {
        callback (err);
        return;
      }

      var wpkg = new WpkgBin (this._resp);

      /* We create or update the index with our new package. */
      wpkg.createIndex (repositoryPath, this._pacmanConfig.pkgIndex, callback);
    };

    if (isSource) {
      process.chdir (packagePath);
      envPath = xCMake.stripShForMinGW ();
      wpkg.buildSrc (repositoryPath, wpkgCallback);
    } else {
      wpkg.build (repositoryPath, packagePath, arch, wpkgCallback);
    }
  }

  /**
   * Build a new standard package.
   *
   * @param {string} packagePath
   * @param {string} distribution
   * @param {string} outputRepository - null for default.
   * @param {function(err, results)} callback
   */
  build (packagePath, distribution, outputRepository, callback) {
    this._build (packagePath, false, distribution, outputRepository, callback);
  }

  /**
   * Build a new source package.
   *
   * @param {string} packagePath
   * @param {string} distribution - Always replaced by 'sources'.
   * @param {string} outputRepository - null for default.
   * @param {function(err, results)} callback
   */
  buildSrc (packagePath, distribution, outputRepository, callback) {
    this._build (packagePath, true, 'sources', outputRepository, callback);
  }

  /**
   * Build a new binary package from a source package.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture
   * @param {string} repository
   * @param {function(err, results)} callback
   */
  buildFromSrc (packageName, arch, repository, callback) {
    const envPath = xCMake.stripShForMinGW ();

    if (!repository) {
      repository = this._xcraftConfig.pkgDebRoot;
    }

    var wpkg = new WpkgBin (this._resp);

    const wpkgCallback = (err) => {
      for (const p of envPath) {
        xEnv.var.path.insert (p.index, p.location);
      }

      if (err) {
        callback (err);
        return;
      }

      /* We create or update the index with our new package. */
      var wpkg = new WpkgBin (this._resp);
      wpkg.createIndex (this._xcraftConfig.pkgDebRoot,
                        this._pacmanConfig.pkgIndex, callback);
    };

    /* Without packageName we consider the build of all source packages. */
    if (!packageName) {
      if (!fs.existsSync (path.join (repository, 'sources'))) {
        callback ('nothing to build');
        return;
      }

      wpkg.build (null, repository, arch, wpkgCallback);
      return;
    }

    this._lookForPackage (packageName, null, arch, null, (err, deb) => {
      if (err) {
        callback (err);
        return;
      }

      wpkg.build (null, deb, arch, wpkgCallback);
    });
  }

  /**
   * List files of a package (data).
   *
   * @param {string} packageName
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  listFiles (packageName, arch, callback) {
    const list = [];

    const wpkg = new WpkgBin (this._resp);

    wpkg.listFiles (packageName, arch, list, (err) => {
      callback (err, list);
    });
  }

  /**
   * Install a package with its dependencies.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture.
   * @param {boolean} reinstall
   * @param {function(err, results)} callback
   */
  install (packageName, arch, reinstall, callback) {
    this._lookForPackage (packageName, null, arch, null, (err, deb) => {
      if (err) {
        callback (err);
        return;
      }

      const wpkg = new WpkgBin (this._resp);
      wpkg.install (deb, arch, reinstall, callback);
    });
  }

  /**
   * Test if a package is already installed.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture
   * @param {function(err, results)} callback
   */
  isInstalled (packageName, arch, callback) {
    var wpkg = new WpkgBin (this._resp);

    wpkg.isInstalled (packageName, arch, (err, code) => {
      if (err) {
        callback (err);
        return;
      }

      callback (null, !code);
    });
  }

  /**
   * Remove a package.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  remove (packageName, arch, callback) {
    var wpkg = new WpkgBin (this._resp);
    wpkg.remove (packageName, arch, callback);
  }

  /**
   * Create the administration directory in the target root.
   * The target root is the destination where are installed the packages.
   *
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  createAdmindir (arch, callback) {
    var xFs = require ('xcraft-core-fs');
    var xPh = require ('xcraft-core-placeholder');

    /* This control file is used in order to create a new admin directory. */
    var fileIn  = path.join (__dirname, './templates/admindir.control');
    var fileOut = path.join (this._xcraftConfig.tempRoot, 'control');

    var ph = new xPh.Placeholder ();
    ph.set ('ARCHITECTURE',     arch)
      .set ('MAINTAINER.NAME',  'Xcraft Toolchain')
      .set ('MAINTAINER.EMAIL', 'xcraft@xcraft.ch')
      .set ('DISTRIBUTION',     this._pacmanConfig.pkgToolchainRepository)
      .injectFile ('ADMINDIR', fileIn, fileOut);

    /* Create the target directory. */
    xFs.mkdir (path.join (this._xcraftConfig.pkgTargetRoot, arch));

    var wpkg = new WpkgBin (this._resp);
    wpkg.createAdmindir (fileOut, arch, callback);
  }

  /**
   * Add one or more global hooks in the admindir.
   *
   * An hook must be a shell or batch script.
   *
   * @param {string[]} hooks - List of scripts paths.
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  addHooks (hooks, arch, callback) {
    const wpkg = new WpkgBin (this._resp);
    wpkg.addHooks (hooks, arch, callback);
  }

  /**
   * Add a new source in the target installation.
   * A source is needed in order to upgrade the packages in the target root
   * accordingly to the versions in the repository referenced in the source.
   *
   * @param {string} sourcePath
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  addSources (sourcePath, arch, callback) {
    var async = require ('async');

    async.auto ({
      checkSources: (callback) => {
        var sourcesList = path.join (this._xcraftConfig.pkgTargetRoot,
                                     arch, 'var/lib/wpkg/core/sources.list');
        var exists = fs.existsSync (sourcesList);
        callback (null, exists);
      },

      listSources: ['checkSources', (callback, results) => {
        var list = [];

        if (!results.checkSources) {
          callback (null, list);
          return;
        }

        var wpkg = new WpkgBin (this._resp);
        wpkg.listSources (arch, list, (err) => {
          callback (err, list);
        });
      }],

      addSources: ['listSources', (callback, results) => {
        /* The list array is populated by listSources. */
        if (results.listSources.indexOf (sourcePath) >= 0) {
          callback ();
          return; /* already in the sources.list */
        }

        var wpkg = new WpkgBin (this._resp);
        wpkg.addSources (sourcePath, arch, callback);
      }]
    }, callback);
  }

  /**
   * Update the list of available packages from the repository.
   *
   * @param {string} arch - Architecture.
   * @param {function(err, results)} callback
   */
  update (arch, callback) {
    var wpkg = new WpkgBin (this._resp);
    wpkg.update (arch, callback);
  }

  /**
   * Publish a package in a specified repository.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture.
   * @param {string} inputRepository
   * @param {string} outputRepository
   * @param {string} distribution
   * @param {function(err, results)} callback
   */
  publish (packageName, arch, inputRepository, outputRepository, distribution, callback) {
    if (!outputRepository) {
      outputRepository = this._xcraftConfig.pkgDebRoot;
    }

    this._lookForPackage (packageName, null, arch, inputRepository, (err, deb) => {
      if (err) {
        callback (err);
        return;
      }

      const dest = path.join (outputRepository, distribution);
      try {
        xFs.mkdir (dest);
        xFs.cp (deb, path.join (dest, path.basename (deb)));
      } catch (ex) {
        callback (ex.stack);
        return;
      }

      const wpkg = new WpkgBin (this._resp);
      /* We create or update the index with our new package. */
      wpkg.createIndex (outputRepository, this._pacmanConfig.pkgIndex, callback);
    });
  }

  /**
   * Unpublish a package from a specified repository.
   *
   * @param {string} packageName
   * @param {string} arch - Architecture.
   * @param {string} repository
   * @param {string} distribution
   * @param {function(err, results)} callback
   */
  unpublish (packageName, arch, repository, distribution, callback) {
    if (!repository) {
      repository = this._xcraftConfig.pkgDebRoot;
    }

    this._lookForPackage (packageName, null, arch, repository, (err, deb) => {
      if (err) {
        callback (err);
        return;
      }

      try {
        xFs.rm (deb);
      } catch (ex) {
        callback (ex.stack);
        return;
      }

      const wpkg = new WpkgBin (this._resp);
      /* We create or update the index with our new package. */
      wpkg.createIndex (repository, this._pacmanConfig.pkgIndex, callback);
    });
  }

  /**
   * Check if a package is already published.
   *
   * @param {string} packageName
   * @param {string} packageVersion
   * @param {string} arch - Architecture.
   * @param {string} repositoryPath - Path on the repository (or null).
   * @param {function(err, results)} callback
   */
  isPublished (packageName, packageVersion, arch, repositoryPath, callback) {
    this._lookForPackage (packageName, packageVersion, arch, repositoryPath, (err, deb) => {
      if (err) {
        this._resp.log.warn (err);
        callback (null, false);
        return;
      }

      callback (null, deb);
    });
  }
}

module.exports = (resp) => new Wpkg (resp);
