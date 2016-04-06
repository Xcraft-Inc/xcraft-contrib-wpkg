'use strict';

const path = require ('path');
const fs   = require ('fs');

const xCMake       = require ('xcraft-contrib-bootcmake');
const xEnv         = require ('xcraft-core-env');
const xFs          = require ('xcraft-core-fs');

const WpkgBin = require ('./lib/bin.js');


/**
 * Retrieve a list of packages available in a repository accordingly to filters.
 *
 * @param {string} repositoryPath
 * @param {string} arch
 * @param {Object} filters
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.listIndexPackages = function (repositoryPath, arch, filters, response, callback) {
  var list = [];

  if (!fs.existsSync (repositoryPath)) {
    callback ('repository not found');
    return;
  }

  var wpkg = new WpkgBin (response, function (err) {
    /* The list array is populated by listIndexPackages. */
    callback (err, list);
  });

  wpkg.listIndexPackages (repositoryPath, arch, filters, list);
};

/**
 * Look in the repository if a specific package exists.
 *
 * @param {string} packageName
 * @param {string} packageVersion
 * @param {string} archRoot - Architecture for the admin dir.
 * @param {string} repositoryPath - Path on the repository (null for default).
 * @param {Object} response
 * @param {function(err, deb)} callback
 */
var lookForPackage = function (packageName, packageVersion, archRoot, repositoryPath, response, callback) {
  const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');

  const repository = repositoryPath || xcraftConfig.pkgDebRoot;

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
  exports.listIndexPackages (repository, archRoot, filters, response, function (err, list) {
   if (err) {
     callback (err);
     return;
   }

   var debFile = list[packageName];
   if (!debFile) {
     response.log.warn ('the package %s is unavailable', packageName);
     callback ('package not found');
     return;
   }

   /* We have found the package, then we can build the full path and install
    * this one to the target root.
    */
   debFile = path.join (repository, debFile);
   callback (null, debFile);
 });
};

var build = function (packagePath, isSource, distribution, outputRepository, response, callback) {
  const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
  const pacmanConfig = require ('xcraft-core-etc') (null, response).load ('xcraft-contrib-pacman');

  const repositoryPath = outputRepository || xcraftConfig.pkgDebRoot;
  var pathObj = packagePath.split (path.sep);

  /* Retrieve the architecture which is in the packagePath. */
  var arch = pathObj[pathObj.length - 2];
  var currentDir = process.cwd ();
  var envPath = null;

  var wpkg = new WpkgBin (response, function (err) {
    if (envPath) {
      xEnv.var.path.insert (envPath.index, envPath.location);
    }
    process.chdir (currentDir);

    if (err) {
      callback (err);
      return;
    }

    var wpkg = new WpkgBin (response, callback);

    /* We create or update the index with our new package. */
    wpkg.createIndex (repositoryPath, pacmanConfig.pkgIndex);
  });

  if (isSource) {
    process.chdir (packagePath);
    envPath = xCMake.stripShForMinGW ();
    wpkg.buildSrc (repositoryPath);
  } else {
    wpkg.build (repositoryPath, packagePath, arch);
  }
};

/**
 * Build a new standard package.
 *
 * @param {string} packagePath
 * @param {string} distribution
 * @param {string} outputRepository - null for default.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.build = function (packagePath, distribution, outputRepository, response, callback) {
  build (packagePath, false, distribution, outputRepository, response, callback);
};

/**
 * Build a new source package.
 *
 * @param {string} packagePath
 * @param {string} distribution - Always replaced by 'sources'.
 * @param {string} outputRepository - null for default.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.buildSrc = function (packagePath, distribution, outputRepository, response, callback) {
  build (packagePath, true, 'sources', outputRepository, response, callback);
};

/**
 * Build a new binary package from a source package.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture
 * @param {string} repository
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.buildFromSrc = function (packageName, arch, repository, response, callback) {
  const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
  const pacmanConfig = require ('xcraft-core-etc') (null, response).load ('xcraft-contrib-pacman');

  const envPath = xCMake.stripShForMinGW ();

  if (!repository) {
    repository = xcraftConfig.pkgDebRoot;
  }

  var wpkg = new WpkgBin (response, function (err) {
    if (envPath) {
      xEnv.var.path.insert (envPath.index, envPath.location);
    }

    if (err) {
      callback (err);
      return;
    }

    /* We create or update the index with our new package. */
    var wpkg = new WpkgBin (response, callback);
    wpkg.createIndex (xcraftConfig.pkgDebRoot, pacmanConfig.pkgIndex);
  });

  /* Without packageName we consider the build of all source packages. */
  if (!packageName) {
    if (!fs.existsSync (path.join (repository, 'sources'))) {
      callback ('nothing to build');
      return;
    }

    wpkg.build (null, repository, arch);
    return;
  }

  lookForPackage (packageName, null, arch, null, response, function (err, deb) {
    if (err) {
      callback (err);
      return;
    }

    wpkg.build (null, deb, arch);
  });
};

/**
 * List files of a package (data).
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.listFiles = function (packageName, arch, response, callback) {
  const list = [];

  const wpkg = new WpkgBin (response, (err) => {
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
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.install = function (packageName, arch, reinstall, response, callback) {
  lookForPackage (packageName, null, arch, null, response, function (err, deb) {
    if (err) {
      callback (err);
      return;
    }

    const wpkg = new WpkgBin (response, callback);
    wpkg.install (deb, arch, reinstall);
  });
};

/**
 * Test if a package is already installed.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.isInstalled = function (packageName, arch, response, callback) {
  var wpkg = new WpkgBin (response, function (err, code) {
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
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.remove = function (packageName, arch, response, callback) {
  var wpkg = new WpkgBin (response, callback);
  wpkg.remove (packageName, arch);
};

/**
 * Create the administration directory in the target root.
 * The target root is the destination where are installed the packages.
 *
 * @param {string} arch - Architecture.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.createAdmindir = function (arch, response, callback) {
  var xFs = require ('xcraft-core-fs');
  var xPh = require ('xcraft-core-placeholder');

  const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
  const pacmanConfig = require ('xcraft-core-etc') (null, response).load ('xcraft-contrib-pacman');

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

  var wpkg = new WpkgBin (response, callback);
  wpkg.createAdmindir (fileOut, arch);
};

/**
 * Add a new source in the target installation.
 * A source is needed in order to upgrade the packages in the target root
 * accordingly to the versions in the repository referenced in the source.
 *
 * @param {string} sourcePath
 * @param {string} arch - Architecture.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.addSources = function (sourcePath, arch, response, callback) {
  const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
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

      var wpkg = new WpkgBin (response, function (err) {
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

      var wpkg = new WpkgBin (response, callback);
      wpkg.addSources (sourcePath, arch);
    }]
  }, callback);
};

/**
 * Update the list of available packages from the repository.
 *
 * @param {string} arch - Architecture.
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.update = function (arch, response, callback) {
  var wpkg = new WpkgBin (response, callback);
  wpkg.update (arch);
};

/**
 * Publish a package in a specified repository.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {string} inputRepository
 * @param {string} outputRepository
 * @param {string} distribution
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.publish = function (packageName, arch, inputRepository, outputRepository, distribution, response, callback) {
  const pacmanConfig = require ('xcraft-core-etc') (null, response).load ('xcraft-contrib-pacman');

  if (!outputRepository) {
    const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
    outputRepository = xcraftConfig.pkgDebRoot;
  }

  lookForPackage (packageName, null, arch, inputRepository, response, function (err, deb) {
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

    const wpkg = new WpkgBin (response, callback);
    /* We create or update the index with our new package. */
    wpkg.createIndex (outputRepository, pacmanConfig.pkgIndex);
  });
};

/**
 * Unpublish a package from a specified repository.
 *
 * @param {string} packageName
 * @param {string} arch - Architecture.
 * @param {string} repository
 * @param {string} distribution
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.unpublish = function (packageName, arch, repository, distribution, response, callback) {
  const pacmanConfig = require ('xcraft-core-etc') (null, response).load ('xcraft-contrib-pacman');

  if (!repository) {
    const xcraftConfig = require ('xcraft-core-etc') (null, response).load ('xcraft');
    repository = xcraftConfig.pkgDebRoot;
  }

  lookForPackage (packageName, null, arch, repository, response, function (err, deb) {
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

    const wpkg = new WpkgBin (response, callback);
    /* We create or update the index with our new package. */
    wpkg.createIndex (repository, pacmanConfig.pkgIndex);
  });
};

/**
 * Check if a package is already published.
 *
 * @param {string} packageName
 * @param {string} packageVersion
 * @param {string} arch - Architecture.
 * @param {string} repositoryPath - Path on the repository (or null).
 * @param {Object} response
 * @param {function(err, results)} callback
 */
exports.isPublished = function (packageName, packageVersion, arch, repositoryPath, response, callback) {
  lookForPackage (packageName, packageVersion, arch, repositoryPath, response, (err, deb) => {
    if (err) {
      response.log.warn (err);
      callback (null, false);
      return;
    }

    callback (null, deb);
  });
};
