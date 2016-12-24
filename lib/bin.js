'use strict';

const path = require ('path');
const fs   = require ('fs');


/**
 * @class wpkg wrapper.
 */
class WpkgBin {
  /**
   * Create a wrapper on wpkg.
   *
   * @param {Object} resp
   * @param {function(err, results)} callback
   */
  constructor (resp, callback) {
    const self = this;

    const xCMake = require ('xcraft-contrib-bootcmake');
    const xSubst = require ('xcraft-core-subst');

    this._cmake = xCMake.getGenerator ();
    this._make  = xCMake.getMakeTool ();
    this._resp  = resp;
    this._xcraftConfig = require ('xcraft-core-etc') (null, resp).load ('xcraft');
    this._pacmanConfig = require ('xcraft-core-etc') (null, resp).load ('xcraft-contrib-pacman');

    const _callback = callback;
    const _tmp = path.join (this._xcraftConfig.xcraftRoot, this._pacmanConfig.wpkgTemp);

    /**
     * Spawn wpkg and handle the outputs.
     *
     * @param {string[]} args - Arguments.
     * @param {string} [lastArg] - The last argument.
     * @param {string} tmp
     * @param {function()} [callback]
     * @param {function(stdout)} [callbackStdout]
     * @param {string[]} callbackStdout.line - The current stdout line.
     */
    const run = (args, lastArg, tmp, callback, callbackStdout) => {
      const xProcess = require ('xcraft-core-process') ({
        logger:    'xlog',
        forwarder: 'wpkg',
        parser:    'wpkg',
        resp:      resp
      });

      const bin = 'wpkg_static';
      const cmdName = args[args.length - 1];

      resp.log.info ('begin command ' + cmdName);

      if (self._pacmanConfig.wpkgTemp && self._pacmanConfig.wpkgTemp.length) {
        args.unshift (tmp);
        args.unshift ('--tmpdir');
      }

      if (lastArg) {
        args.push (lastArg);
      }

      resp.log.verb ('%s %s', bin, args.join (' '));

      xProcess.spawn (bin, args, {}, (err, code) => {
        /* When the call is terminated. */
        resp.log.info ('end command ' + cmdName + ' with rc ' + code);

        if (callback) {
          callback (err, code);
        }
      }, callbackStdout);
    };

    this._run = (args, lastArg, callbackStdout) => {
      xSubst.wrap (_tmp, resp, (err, dest, callback) => {
        run (args, lastArg, dest, callback, callbackStdout);
      }, _callback);
    };
  }

  _addRepositories () {
    const xcraftConfig = require ('xcraft-core-etc') (null, this._resp).load ('xcraft');

    let first = true;
    const args  = [];

    const repo = xcraftConfig.pkgDebRoot;
    if (fs.existsSync (repo)) {
      if (first) {
        args.push ('--repository');
        first = false;
      }
      args.push (repo);
    }

    return args;
  }

  build (repositoryPath, packagePath, arch) {
    let args = [];

    const root = path.join (this._xcraftConfig.pkgTargetRoot, arch);
    if (fs.existsSync (root)) {
      args = ['--root', root];
    }

    args = args.concat ([
      '--verbose',
      '--force-file-info',
      '--output-repository-dir', repositoryPath || this._xcraftConfig.pkgDebRoot,
      '--install-prefix', '/usr',
      '--compressor', 'gz',
      '--zlevel', 6,
      '--cmake-generator', this._cmake,
      '--make-tool', this._make
    ]);

    args = args.concat (this._addRepositories (this._resp));
    args.push ('--build');

    this._run (args, packagePath);
  }

  buildSrc (repositoryPath) {
    const args = [
      '--verbose',
      '--output-repository-dir', repositoryPath || this._xcraftConfig.pkgDebRoot,
      '--cmake-generator', this._cmake,
      '--make-tool', this._make,
      '--build'
    ];

    this._run (args);
  }

  createIndex (repositoryPath, indexName) {
    const args = [
      '--verbose',
      '--repository', repositoryPath,
      '--recursive',
      '--create-index'
    ];

    this._run (args, path.join (repositoryPath, indexName));
  }

  install (packagePath, arch, reinstall) {
    let args = [
      '--verbose',
      '--force-file-info',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch)
    ];

    args = args.concat (this._addRepositories (this._resp));

    if (!reinstall) {
      args.push ('--skip-same-version');
    }

    args.push ('--install');

    this._run (args, packagePath);
  }

  isInstalled (packageName, arch) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--is-installed'
    ];

    this._run (args, packageName);
  }

  remove (packageName, arch) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--remove'
    ];

    this._run (args, packageName);
  }

  createAdmindir (controlFile, arch) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--create-admindir'
    ];

    this._run (args, controlFile);
  }

  addSources (source, arch) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--add-sources'
    ];

    this._run (args, source);
  }

  listSources (arch, listOut) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--list-sources'
    ];

    this._run (args, null, (line) => {
      if (!line.trim ().length) {
        return;
      }

      listOut.push (line.trim ());
    });
  }

  listFiles (packageName, arch, listOut) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--listfiles'
    ];

    this._run (args, packageName, (line) => {
      if (!line.trim ().length) {
        return;
      }

      listOut.push (line.trim ());
    });
  }

  update (arch) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--update'
    ];

    this._run (args);
  }

  listIndexPackages (repositoryPath, arch, filters, listOut) {
    const xUtils = require ('xcraft-core-utils');

    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--list-index-packages'
    ];

    this._run (args, path.join (repositoryPath, this._pacmanConfig.pkgIndex), (line) => {
      const result = line.trim ().match (/.* (?:(.*)\/)?([^ _]*)_([^ _]*)(?:_([^ _]*))?\.ctrl$/);

      const deb = {
        distrib: result[1],
        name:    result[2],
        version: result[3],
        arch:    result[4]
      };

      const res = Object.keys (deb).every ((it) => {
        if (!deb[it] || !filters[it]) {
          return true;
        }

        return xUtils.regex.toRegexp (filters[it]).test (deb[it]);
      });

      if (!res) {
        return;
      }

      let debFile = '';
      if (deb.distrib) {
        debFile = deb.distrib + '/';
      }
      debFile += deb.name + '_' + deb.version;

      if (deb.arch) {
        debFile += '_' + deb.arch;
      }

      listOut[deb.name] = debFile + '.deb';
    });
  }

  addHooks (hooks, arch) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--add-hooks'
    ].concat (hooks);

    this._run (args);
  }
}

module.exports = WpkgBin;
