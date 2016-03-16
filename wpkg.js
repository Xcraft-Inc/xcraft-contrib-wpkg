'use strict';

const moduleName = 'wpkg';

const path = require ('path');
const fs   = require ('fs');

const xLog         = require ('xcraft-core-log') (moduleName);
const xCMake       = require ('xcraft-contrib-bootcmake');
const xEnv         = require ('xcraft-core-env');
const xFs          = require ('xcraft-core-fs');
const xcraftConfig = require ('xcraft-core-etc').load ('xcraft');
const pacmanConfig = require ('xcraft-core-etc').load ('xcraft-contrib-pacman');

const WpkgBin = require ('./lib/bin.js');


/**
 * Retrieve a list of packages available in a repository accordingly to filters.
 *
 * @param {string} repositoryPath
 * @param {string} arch
 * @param {Object} filters
 * @param {function(err, results)} callback
 */
exports.listIndexPackages = function (repositoryPath, arch, filters, callback) {
  var list = [];

  if (!fs.existsSync (repositoryPath)) {
    callback ('repository not found');
    return;
  }

  var wpkg = new WpkgBin (function (err) {
    /* The list array is populated by listIndexPackages. */
    callback (err, list);
  });

  wpkg.listIndexPackages (repositoryPath, arch, filters, list);
};

var lookForPackage = function (packageName, archRoot, callback) {
  var repositoryPath = xcraftConfig.pkgDebRoot;

  var filters = {
    name: packageName,
    arch: new RegExp ('(' + archRoot + '|all)')
  };

  /* wpkg is able to install a package just by its name. But it's not possible
   * in this case to specify for example a version. And there is a regression
   * with the new way. Then we must look in the repository index file if
   * the package exists and in order to retrieve the full package name.
   */
  exports.listIndexPackages (repositoryPath, archRoot, filters, function (err, list) {
   if (err) {
     callback (err);
     return;
   }

   var debFile = list[packageName];
   if (!debFile) {
     xLog.warn ('the package %s is unavailable', packageName);
     callback ('package not found');
     return;
   }

   /* We have found the package, then we can build the full path and install
    * this one to the target root.
    */
   debFile = path.join (repositoryPath, debFile);
   callback (null, debFile);
 });
};

var build = function (packagePath, isSource, distribution, callback) {
  var pathObj = packagePath.split (path.sep);

  /* Retrieve the architecture which is in the packagePath. */
  var arch = pathObj[pathObj.length - 2];
  var currentDir = process.cwd ();
  var envPath = null;

  var wpkg = new WpkgBin (function (err) {
    if (envPath) {
      xEnv.var.path.insert (envPath.index, envPath.location);
    }
    process.chdir (currentDir);

    if (err) {
      callback (err);
      return;
    }

    var wpkg = new WpkgBin (callback);
    var repositoryPath = xcraftConfig.pkgDebRoot;

    /* We create or update the index with our new package. */
    wpkg.createIndex (repositoryPath, pacmanConfig.pkgIndex);
  });

  if (isSource) {
    process.chdir (packagePath);
    envPath = xCMake.stripShForMinGW ();
    wpkg.buildSrc ();
  } else {
    wpkg.build (packagePath, arch);
  }
};

/**
 * Build a new standard package.
 *
 * @param {string} packagePath
 * @param {string} distribution
 * @param {function(err, results)} callback
 */
exports.build = function (packagePath, distribution, callback) {
  build (packagePath, false, distribution, callback);
};

/**
 * Build a new source package.
 *
 * @param {string} packagePath
 * @param {string} distribution - Always replaced by 'sources'.
 * @param {function(err, results)} callback
 */
exports.buildSrc = function (packagePath, distribution, callback) {
  build (packagePath, true, 'sources', callback);
};

/**
 * Build a new binary package from a source package.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture
 * @param {string} distribution
 * @param {function(err, results)} callback
 */
exports.buildFromSrc = function (packageName, arch, distribution, callback) {
  const envPath = xCMake.stripShForMinGW ();

  var wpkg = new WpkgBin (function (err) {
    if (envPath) {
      xEnv.var.path.insert (envPath.index, envPath.location);
    }

    if (err) {
      callback (err);
      return;
    }

    var repositoryPath = xcraftConfig.pkgDebRoot;

    /* We create or update the index with our new package. */
    var wpkg = new WpkgBin (callback);
    wpkg.createIndex (repositoryPath, pacmanConfig.pkgIndex);
  });

  /* Without packageName we consider the build of all source packages. */
  if (!packageName) {
    if (!fs.existsSync (path.join (xcraftConfig.pkgDebRoot, 'sources'))) {
      xLog.info ('nothing to build');
      callback ();
      return;
    }

    wpkg.build (xcraftConfig.pkgDebRoot, arch);
    return;
  }

  lookForPackage (packageName, arch, function (err, deb) {
    if (err) {
      callback (err);
      return;
    }

    wpkg.build (deb, arch);
  });
};

/**
 * List files of a package (data).
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {function(err, results)} callback
 */
exports.listFiles = function (packageName, arch, callback) {
  const list = [];

  const wpkg = new WpkgBin ((err) => {
    callback (err, list);
  });

  wpkg.listFiles (packageName, arch, list);
};

/**
 * Install a package with its dependencies.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {boolean} reinstall
 * @param {function(err, results)} callback
 */
exports.install = function (packageName, arch, reinstall, callback) {
  lookForPackage (packageName, arch, function (err, deb) {
    if (err) {
      callback (err);
      return;
    }

    const wpkg = new WpkgBin (callback);
    wpkg.install (deb, arch, reinstall);
  });
};

/**
 * Test if a package is already installed.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture
 * @param {function(err, results)} callback
 */
exports.isInstalled = function (packageName, arch, callback) {
  var wpkg = new WpkgBin (function (err, code) {
    if (err) {
      callback (err);
      return;
    }

    callback (null, !code);
  });

  wpkg.isInstalled (packageName, arch);
};

/**
 * Remove a package.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {function(err, results)} callback
 */
exports.remove = function (packageName, arch, callback) {
  var wpkg = new WpkgBin (callback);
  wpkg.remove (packageName, arch);
};

/**
 * Create the administration directory in the target root.
 * The target root is the destination where are installed the packages.
 *
 * @param {string} arch - Architecture.
 * @param {function(err, results)} callback
 */
exports.createAdmindir = function (arch, callback) {
  var xFs = require ('xcraft-core-fs');
  var xPh = require ('xcraft-core-placeholder');

  /* This control file is used in order to create a new admin directory. */
  var fileIn  = path.join (__dirname, './templates/admindir.control');
  var fileOut = path.join (xcraftConfig.tempRoot, 'control');

  var ph = new xPh.Placeholder ();
  ph.set ('ARCHITECTURE',     arch)
    .set ('MAINTAINER.NAME',  'Xcraft Toolchain')
    .set ('MAINTAINER.EMAIL', 'xcraft@xcraft.ch')
    .set ('DISTRIBUTION',     pacmanConfig.pkgToolchainRepository)
    .injectFile ('ADMINDIR', fileIn, fileOut);

  /* Create the target directory. */
  xFs.mkdir (path.join (xcraftConfig.pkgTargetRoot, arch));

  var wpkg = new WpkgBin (callback);
  wpkg.createAdmindir (fileOut, arch);
};

/**
 * Add a new source in the target installation.
 * A source is needed in order to upgrade the packages in the target root
 * accordingly to the versions in the repository referenced in the source.
 *
 * @param {string} sourcePath
 * @param {string} arch - Architecture.
 * @param {function(err, results)} callback
 */
exports.addSources = function (sourcePath, arch, callback) {
  var async = require ('async');

  async.auto ({
    checkSources: function (callback) {
      var sourcesList = path.join (xcraftConfig.pkgTargetRoot,
                                   arch, 'var/lib/wpkg/core/sources.list');
      var exists = fs.existsSync (sourcesList);
      callback (null, exists);
    },

    listSources: ['checkSources', function (callback, results) {
      var list = [];

      if (!results.checkSources) {
        callback (null, list);
        return;
      }

      var wpkg = new WpkgBin (function (err) {
        callback (err, list);
      });
      wpkg.listSources (arch, list);
    }],

    addSources: ['listSources', function (callback, results) {
      /* The list array is populated by listSources. */
      if (results.listSources.indexOf (sourcePath) >= 0) {
        callback ();
        return; /* already in the sources.list */
      }

      var wpkg = new WpkgBin (callback);
      wpkg.addSources (sourcePath, arch);
    }]
  }, callback);
};

/**
 * Update the list of available packages from the repository.
 *
 * @param {string} arch - Architecture.
 * @param {function(err, results)} callback
 */
exports.update = function (arch, callback) {
  var wpkg = new WpkgBin (callback);
  wpkg.update (arch);
};

/**
 * Publish a package in a specified repository.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {string} outputRepository
 * @param {string} distribution
 * @param {function(err, results)} callback
 */
exports.publish = function (packageName, arch, outputRepository, distribution, callback) {
  lookForPackage (packageName, arch, function (err, deb) {
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

    const wpkg = new WpkgBin (callback);
    /* We create or update the index with our new package. */
    wpkg.createIndex (outputRepository, pacmanConfig.pkgIndex);
  });
};
