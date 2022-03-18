'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');

const xPacman = require('xcraft-contrib-pacman');

/**
 * @class wpkg wrapper.
 */
class WpkgBin {
  /**
   * Create a wrapper on wpkg.
   *
   * @param {Object} resp
   */
  constructor(resp, targetRoot, env) {
    const xPlatform = require('xcraft-core-platform');

    watt.wrapAll(this);

    this._cmake =
      xPlatform.getOs() === 'win' ? 'MSYS Makefiles' : 'Unix Makefiles';
    this._make = 'make';
    this._resp = resp;
    this._xcraftConfig = require('xcraft-core-etc')(null, resp).load('xcraft');
    this._pacmanConfig = require('xcraft-core-etc')(null, resp).load(
      'xcraft-contrib-pacman'
    );
    this._targetRoot = targetRoot || this._xcraftConfig.pkgTargetRoot;
    this._exception = ['.gitignore', '.gitattributes'];
    this._env = env;
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
  *_runWpkg(args, lastArg, tmp, callbackStdout, next) {
    const xProcess = require('xcraft-core-process')({
      logger: 'xlog',
      forwarder: 'wpkg',
      parser: 'wpkg',
      resp: this._resp,
    });

    const bin = 'wpkg_static';
    const cmdName = args[args.length - 1];

    this._resp.log.info('begin command ' + cmdName);

    if (tmp) {
      args.unshift(tmp);
      args.unshift('--tmpdir');
    } else if (this._pacmanConfig.wpkgTemp) {
      args.unshift(
        path.join(this._xcraftConfig.xcraftRoot, this._pacmanConfig.wpkgTemp)
      );
      args.unshift('--tmpdir');
    }

    if (lastArg) {
      args.push(lastArg);
    }

    this._resp.log.verb('%s %s', bin, args.join(' '));

    const opts = this._env
      ? {env: Object.assign({}, process.env, this._env)}
      : {};
    const code = yield xProcess.spawn(bin, args, opts, next, callbackStdout);
    this._resp.log.info('end command ' + cmdName + ' with rc ' + code);
    return code;
  }

  *_run(args, lastArg, callbackStdout, next) {
    const xSubst = require('xcraft-core-subst');

    const tmp = path.join(
      this._xcraftConfig.xcraftRoot,
      this._pacmanConfig.wpkgTemp
    );

    return yield xSubst.wrap(
      tmp,
      this._resp,
      (err, dest, callback) => {
        this._runWpkg(args, lastArg, dest, callbackStdout, callback);
      },
      next
    );
  }

  /**
   * Spawn deb2graph and handle the outputs.
   *
   * @param {string[]} args - Arguments.
   * @param {Function} [callbackStdout]
   * @param {string[]} callbackStdout.line - The current stdout line.
   * @param {Function} [next]
   */
  *_runDeb2graph(args, callbackStdout, next) {
    const which = require('which');
    const xProcess = require('xcraft-core-process')({
      logger: 'xlog',
      forwarder: 'wpkg',
      parser: 'wpkg',
      resp: this._resp,
    });

    const bin = 'deb2graph';

    if (!which.sync('dot', {nothrow: true})) {
      args.unshift('--skip-svg');
    }

    this._resp.log.verb('%s %s', bin, args.join(' '));

    const opts = this._env
      ? {env: Object.assign({}, process.env, this._env)}
      : {};
    return yield xProcess.spawn(bin, args, opts, next, callbackStdout);
  }

  _addRepositories(distribution) {
    // const xcraftConfig = require('xcraft-core-etc')(null, this._resp).load(
    //   'xcraft'
    // );

    const repo0 = xPacman.getDebRoot(distribution, this._resp);
    // const repo1 = xcraftConfig.pkgDebRoot;

    const repositories = [repo0];
    // if (repo0 !== repo1) {
    //  repositories.push(repo1);
    // }

    const args = repositories.filter((repo) => fs.existsSync(repo));
    if (args.length) {
      args.unshift('--repository');
    }

    return args;
  }

  *build(repositoryPath, packagePath, arch, distribution, next) {
    let args = [];

    const root = path.join(this._targetRoot, arch);
    if (fs.existsSync(root)) {
      args = ['--root', root];
    }

    args = args.concat([
      '--verbose',
      '--accept-special-windows-filename',
      '--force-file-info',
      '--output-repository-dir',
      repositoryPath || xPacman.getDebRoot(distribution, this._resp),
      '--install-prefix',
      '/usr',
      '--compressor',
      'zstd',
      '--zlevel',
      3,
      '--cmake-generator',
      this._cmake,
      '--make-tool',
      this._make,
    ]);

    args.push('--exception', ...this._exception);

    args = args.concat(this._addRepositories(distribution));
    args.push('--build');

    return yield this._run(args, packagePath, null, next);
  }

  *buildSrc(repositoryPath, distribution, next) {
    const args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--output-repository-dir',
      repositoryPath || xPacman.getDebRoot(distribution, this._resp),
      '--compressor',
      'zstd',
      '--zlevel',
      3,
      '--cmake-generator',
      this._cmake,
      '--make-tool',
      this._make,
    ];

    args.push('--exception', ...this._exception);
    args.push('--build');

    return yield this._run(args, null, null, next);
  }

  *createIndex(repositoryPath, indexName, next) {
    const args = [
      '--verbose',
      '--repository',
      repositoryPath,
      '--recursive',
      '--create-index',
    ];

    return yield this._runWpkg(
      args,
      path.join(repositoryPath, indexName),
      null,
      null,
      next
    );
  }

  *install(packagePath, arch, distribution, reinstall, next) {
    let args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--force-file-info',
      '--root',
      path.join(this._targetRoot, arch),
    ];

    args = args.concat(this._addRepositories(distribution));

    if (!reinstall) {
      args.push('--skip-same-version');
    }

    args.push('--install');

    return yield this._run(args, packagePath, null, next);
  }

  *isInstalled(packageName, arch, next) {
    const args = [
      '--root',
      path.join(this._targetRoot, arch),
      '--is-installed',
    ];

    return yield this._runWpkg(args, packageName, null, null, next);
  }

  *fields(packageName, arch, next) {
    const args = [
      '--root',
      path.join(this._targetRoot, arch),
      '--field',
      packageName,
      'Version',
      'X-Status',
    ];

    const fields = {};

    const code = yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        const match = line.match(/([^:]+):(.*)/);
        const key = match[1].replace('X-', '').toLowerCase();
        const value = match[2].trim();
        fields[key] = value;
      },
      next
    );

    return code ? null : fields;
  }

  *show(packagePath, next) {
    const format = [
      'Architecture',
      'Build-Depends',
      'Depends',
      'Package',
      'Version',
      'X-Craft-Build-Depends',
      'X-Craft-Make-Depends',
    ].reduce((state, dep) => {
      state[dep] = `\${${dep}}`;
      return state;
    }, {});

    const args = [
      '--showformat',
      JSON.stringify(format) + '\n',
      '--show',
      packagePath,
    ];

    let output = {};
    const code = yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        output = JSON.parse(line);
      },
      next
    );

    return code ? null : output;
  }

  *remove(packageName, arch, recursive, next) {
    const args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--root',
      path.join(this._targetRoot, arch),
    ];

    if (recursive) {
      args.push('--recursive');
    }

    args.push('--remove');

    return yield this._run(args, packageName, null, next);
  }

  *createAdmindir(controlFile, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--create-admindir',
    ];

    return yield this._runWpkg(args, controlFile, null, null, next);
  }

  *addSources(source, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--add-sources',
    ];

    return yield this._runWpkg(args, source, null, null, next);
  }

  *removeSources(sourceRow, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--remove-sources',
    ];

    return yield this._runWpkg(args, sourceRow, null, null, next);
  }

  *listSources(arch, listOut, rows, next) {
    const args = [
      '--root',
      path.join(this._targetRoot, arch),
      '--list-sources',
    ];

    if (rows) {
      args.unshift('--verbose');
    }

    return yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        if (!line.trim().length) {
          return;
        }

        listOut.push(line.trim());
      },
      next
    );
  }

  *listFiles(packageName, arch, listOut, next) {
    const args = ['--root', path.join(this._targetRoot, arch), '--listfiles'];

    return yield this._runWpkg(
      args,
      packageName,
      null,
      (line) => {
        if (line.trim()) {
          listOut.push(line.trim());
        }
      },
      next
    );
  }

  *list(arch, pattern, listOut, next) {
    const args = ['--root', path.join(this._targetRoot, arch), '--list'];
    if (pattern) {
      args.push(pattern);
    }

    return yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        if (line.trim()) {
          listOut.push(line.trim());
        }
      },
      next
    );
  }

  *search(arch, pattern, listOut, next) {
    const args = [
      '--root',
      path.join(this._targetRoot, arch),
      '--accept-special-windows-filename',
      '--search',
      pattern,
    ];

    return yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        if (line.trim()) {
          listOut.push(line.trim());
        }
      },
      next
    );
  }

  *unlock(arch, next) {
    const args = [
      '--root',
      path.join(this._targetRoot, arch),
      '--remove-database-lock',
    ];

    return yield this._runWpkg(args, null, null, null, next);
  }

  *update(arch, next) {
    if (
      !fs.existsSync(
        path.join(this._targetRoot, arch, 'var/lib/wpkg/core/sources.list')
      )
    ) {
      return;
    }

    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--update',
    ];

    return yield this._runWpkg(args, null, null, null, next);
  }

  *upgrade(arch, next) {
    if (
      !fs.existsSync(
        path.join(this._targetRoot, arch, 'var/lib/wpkg/core/sources.list')
      )
    ) {
      return;
    }

    const args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--force-file-info',
      '--root',
      path.join(this._targetRoot, arch),
      '--upgrade',
    ];

    return yield this._run(args, null, null, next);
  }

  *isV1Greater(v1, v2, next) {
    const args = ['--compare-versions', v1, '>', v2];

    const code = yield this._runWpkg(args, null, null, null, next);
    return code === 0;
  }

  *listIndexPackages(repositoryPath, arch, filters, listOut, next) {
    const xUtils = require('xcraft-core-utils');

    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--list-index-packages',
    ];

    const list = {};
    const filtered = [];

    const res = yield this._runWpkg(
      args,
      path.join(repositoryPath, this._pacmanConfig.pkgIndex),
      null,
      (line) => {
        const result = line
          .trim()
          .match(/.* (?:(.*)\/)?([^ _]*)_([^ _]*)(?:_([^ _]*))?\.ctrl$/);

        const deb = {
          distrib: result[1],
          name: result[2],
          version: result[3],
          arch: result[4],
        };

        const res = Object.keys(deb).every((it) => {
          if (!deb[it] || !filters[it]) {
            return true;
          }

          return xUtils.regex.toRegexp(filters[it]).test(deb[it]);
        });

        if (!res) {
          return;
        }

        if (!list[deb.name]) {
          list[deb.name] = [];
        }

        list[deb.name].push(deb);
      },
      next
    );

    const wpkg = new WpkgBin(this._resp);

    /* if multiple versions exists, then keep the greater */
    for (let debs of Object.keys(list)) {
      debs = list[debs];

      if (debs.length <= 1) {
        filtered.push(debs[0]);
        continue;
      }

      let greater = debs[0];
      for (let i = 1; i < debs.length; ++i) {
        if (yield wpkg.isV1Greater(debs[i].version, greater.version)) {
          greater = debs[i];
        }
      }

      filtered.push(greater);
    }

    filtered.forEach((deb) => {
      let debFile = '';
      if (deb.distrib) {
        debFile = deb.distrib + '/';
      }
      debFile += deb.name + '_' + deb.version;

      if (deb.arch) {
        debFile += '_' + deb.arch;
      }

      listOut[deb.name] = {
        name: deb.name,
        version: deb.version,
        arch: deb.arch,
        distrib: deb.distrib,
        file: debFile + '.deb',
      };
    });

    return res;
  }

  *addHooks(hooks, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--add-hooks',
    ].concat(hooks);

    return yield this._runWpkg(args, null, null, null, next);
  }

  *graph(debs, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      ...debs,
    ];

    return yield this._runDeb2graph(args, null, next);
  }
}

module.exports = WpkgBin;
