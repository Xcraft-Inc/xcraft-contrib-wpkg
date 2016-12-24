'use strict';

const path = require ('path');
const fs   = require ('fs');
const watt = require ('watt');


/**
 * @class wpkg wrapper.
 */
class WpkgBin {
  /**
   * Create a wrapper on wpkg.
   *
   * @param {Object} resp
   */
  constructor (resp) {
    const xCMake = require ('xcraft-contrib-bootcmake');

    watt.wrapAll (this);

    this._cmake = xCMake.getGenerator ();
    this._make  = xCMake.getMakeTool ();
    this._resp  = resp;
    this._xcraftConfig = require ('xcraft-core-etc') (null, resp).load ('xcraft');
    this._pacmanConfig = require ('xcraft-core-etc') (null, resp).load ('xcraft-contrib-pacman');
  }

  /**
   * Spawn wpkg and handle the outputs.
   *
   * @param {string[]} args - Arguments.
   * @param {string} [lastArg] - The last argument.
   * @param {string} tmp
   * @param {Function} [callbackStdout]
   * @param {string[]} callbackStdout.line - The current stdout line.
   * @param {Function} [next]
   */
  * _runWpkg (args, lastArg, tmp, callbackStdout, next) {
    const xProcess = require ('xcraft-core-process') ({
      logger:    'xlog',
      forwarder: 'wpkg',
      parser:    'wpkg',
      resp:      this._resp
    });

    const bin = 'wpkg_static';
    const cmdName = args[args.length - 1];

    this._resp.log.info ('begin command ' + cmdName);

    if (this._pacmanConfig.wpkgTemp && this._pacmanConfig.wpkgTemp.length) {
      args.unshift (tmp);
      args.unshift ('--tmpdir');
    }

    if (lastArg) {
      args.push (lastArg);
    }

    this._resp.log.verb ('%s %s', bin, args.join (' '));

    const code = yield xProcess.spawn (bin, args, {}, next, callbackStdout);
    this._resp.log.info ('end command ' + cmdName + ' with rc ' + code);
    return code;
  }

  * _run (args, lastArg, callbackStdout, next) {
    const xSubst = require ('xcraft-core-subst');

    const tmp = path.join (this._xcraftConfig.xcraftRoot, this._pacmanConfig.wpkgTemp);

    return yield xSubst.wrap (tmp, this._resp, (err, dest, callback) => {
      this._runWpkg (args, lastArg, dest, callbackStdout, callback);
    }, next);
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

  * build (repositoryPath, packagePath, arch, next) {
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

    yield this._run (args, packagePath, null, next);
  }

  * buildSrc (repositoryPath, next) {
    const args = [
      '--verbose',
      '--output-repository-dir', repositoryPath || this._xcraftConfig.pkgDebRoot,
      '--cmake-generator', this._cmake,
      '--make-tool', this._make,
      '--build'
    ];

    yield this._run (args, null, null, next);
  }

  * createIndex (repositoryPath, indexName, next) {
    const args = [
      '--verbose',
      '--repository', repositoryPath,
      '--recursive',
      '--create-index'
    ];

    yield this._run (args, path.join (repositoryPath, indexName), null, next);
  }

  * install (packagePath, arch, reinstall, next) {
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

    yield this._run (args, packagePath, null, next);
  }

  * isInstalled (packageName, arch, next) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--is-installed'
    ];

    yield this._run (args, packageName, null, next);
  }

  * remove (packageName, arch, next) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--remove'
    ];

    yield this._run (args, packageName, null, next);
  }

  * createAdmindir (controlFile, arch, next) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--create-admindir'
    ];

    yield this._run (args, controlFile, null, next);
  }

  * addSources (source, arch, next) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--add-sources'
    ];

    yield this._run (args, source, null, next);
  }

  * listSources (arch, listOut, next) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--list-sources'
    ];

    yield this._run (args, null, (line) => {
      if (!line.trim ().length) {
        return;
      }

      listOut.push (line.trim ());
    }, next);
  }

  * listFiles (packageName, arch, listOut, next) {
    const args = [
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--listfiles'
    ];

    yield this._run (args, packageName, (line) => {
      if (!line.trim ().length) {
        return;
      }

      listOut.push (line.trim ());
    }, next);
  }

  * update (arch, next) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--update'
    ];

    yield this._run (args, null, null, next);
  }

  * listIndexPackages (repositoryPath, arch, filters, listOut, next) {
    const xUtils = require ('xcraft-core-utils');

    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--list-index-packages'
    ];

    yield this._run (args, path.join (repositoryPath, this._pacmanConfig.pkgIndex), (line) => {
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
    }, next);
  }

  * addHooks (hooks, arch, next) {
    const args = [
      '--verbose',
      '--root', path.join (this._xcraftConfig.pkgTargetRoot, arch),
      '--add-hooks'
    ].concat (hooks);

    yield this._run (args, null, null, next);
  }
}

module.exports = WpkgBin;
