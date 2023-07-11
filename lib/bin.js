'use strict';

const path = require('path');
const watt = require('gigawatts');

const xPacman = require('xcraft-contrib-pacman');
const xFs = require('xcraft-core-fs');
const {fse} = require('xcraft-core-fs');
const MapLimit = require('./mapLimit.js');

class WpkgBin {
  static #indexCache = new MapLimit(20);

  /**
   * Create a wrapper on wpkg.
   *
   * @param {object} resp - Response handler.
   * @param {string} targetRoot - Package target root.
   * @param {object} env - Environment variables.
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
   * @yields
   * @param {string[]} args - Arguments.
   * @param {string} [lastArg] - The last argument.
   * @param {string} tmp - The temporary directory.
   * @param {Function} [callbackStdout] -  Stdout's callback.
   * @param {Function} [next] - Watt's callback.
   * @returns {number} the return code.
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
   * @yields
   * @param {string[]} args - Arguments.
   * @param {Function} [callbackStdout] - Stdout's callback.
   * @param {string[]} callbackStdout.line - The current stdout line.
   * @param {Function} [next] - Watt's callback.
   * @returns {*} The program handler.
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

    const args = repositories.filter((repo) => xFs.fse.existsSync(repo));
    if (args.length) {
      args.unshift('--repository');
    }

    return args;
  }

  *build(repositoryPath, packagePath, arch, distribution, next) {
    let args = [];

    const root = path.join(this._targetRoot, arch);
    if (xFs.fse.existsSync(root)) {
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

    /* In case of building a whole source repository, we don't provide
     * more repositories because all needed packages _must_ be available
     * in packagePath as -src packages.
     */
    if (packagePath.endsWith('.deb')) {
      args = args.concat(this._addRepositories(distribution));
    }

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
      '--depth',
      '1',
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

  *show(packagePath, distribution, next) {
    const format = [
      'Architecture',
      'Build-Depends',
      'Date',
      'Depends',
      'Distribution',
      'Package',
      'Version',
      'X-Craft-Build-Depends',
      'X-Craft-Make-Depends',
      `X-Craft-Packages-${distribution}`,
      'X-Craft-Sub-Packages',
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

    let output = '';
    const code = yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        output += line;
      },
      next
    );

    return code ? null : JSON.parse(output);
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

  *autoremove(arch, next) {
    const args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--root',
      path.join(this._targetRoot, arch),
      '--autoremove',
    ];

    return yield this._run(args, null, null, next);
  }

  *setSelection(packageName, arch, selection, next) {
    const args = [
      '--verbose',
      '--accept-special-windows-filename',
      '--root',
      path.join(this._targetRoot, arch),
      '--set-selection',
      selection,
    ];

    return yield this._run(args, packageName, null, next);
  }

  *createAdmindir(controlFile, arch, next) {
    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--create-admindir',
    ];

    const result = yield this._runWpkg(args, controlFile, null, null, next);

    /* Generate empty sources.list file in order to prevent error with wpkg
     * when it tries to update and upgrade the admindir after a build.
     */
    const sources = path.join(
      this._targetRoot,
      arch,
      'var/lib/wpkg/core/sources.list'
    );
    xFs.fse.createFileSync(sources);

    return result;
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

    let skip = true;
    return yield this._runWpkg(
      args,
      null,
      null,
      (line) => {
        line = line.trim();
        if (line.startsWith('+++')) {
          skip = false;
        } else if (!skip && line) {
          const matches = line.match(
            /^([^ ]{2,3})[ ]+([^ ]+)[ ]+([^ ]+)[ ]+([^ ].*)/
          );
          if (!matches) {
            return;
          }
          listOut.push({
            Name: matches[2],
            Version: matches[3],
            Description: matches[4],
          });
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
      !xFs.fse.existsSync(
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
      !xFs.fse.existsSync(
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

  *listIndexPackages(repositoryPath, arch, filters, listOut, options, next) {
    const xUtils = require('xcraft-core-utils');

    const args = [
      '--verbose',
      '--root',
      path.join(this._targetRoot, arch),
      '--list-index-packages-json',
    ];

    const list = {};
    const filtered = [];
    const indexPath = path.join(repositoryPath, this._pacmanConfig.pkgIndex);

    if (!xFs.fse.existsSync(indexPath)) {
      return;
    }

    let rc;
    let result = '';
    const hash = xUtils.crypto.sha256(fse.readFileSync(indexPath));

    if (!WpkgBin.#indexCache.has(hash)) {
      rc = yield this._runWpkg(
        args,
        indexPath,
        null,
        (line) => (result += line),
        next
      );

      result = JSON.parse(
        /* Try to fix for Windows because it seems bugged with wpkg */
        result.replace(/(^|[^\\])[\\]([^\\]|$)/g, '$1\\\\$2')
      );
      result = result[indexPath];
      WpkgBin.#indexCache.set(hash, result);
    } else {
      result = WpkgBin.#indexCache.get(hash);
    }

    for (const [filename, meta] of Object.entries(result)) {
      const deb = {
        distrib:
          filename.indexOf('/') !== -1
            ? filename.replace(/(.*)\/.*/, '$1')
            : null,
        name: meta.name,
        version: meta.version,
        arch: meta.architecture !== 'source' ? meta.architecture : null,
        ctrlDistribution: meta.distribution,
      };

      const res = Object.keys(deb).every((it) => {
        if (!deb[it] || !filters?.[it]) {
          return true;
        }

        return xUtils.regex.toRegexp(filters[it]).test(deb[it]);
      });

      if (!res) {
        continue;
      }

      if (!list[deb.name]) {
        list[deb.name] = [];
      }

      list[deb.name].push(deb);
    }

    const wpkg = new WpkgBin(this._resp);

    /* if multiple versions exists, then keep the greater */
    for (let debs of Object.keys(list)) {
      debs = list[debs];

      if (!options?.greater || debs.length <= 1) {
        filtered.push(...debs);
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

      const payload = {
        name: deb.name,
        version: deb.version,
        arch: deb.arch,
        distrib: deb.distrib,
        file: debFile + '.deb',
        ctrl: {
          Distribution: deb.ctrlDistribution,
        },
      };

      if (options?.greater) {
        listOut[deb.name] = payload;
      } else {
        if (!listOut[deb.name]) {
          listOut[deb.name] = {};
        }
        listOut[deb.name][deb.version] = payload;
      }
    });

    return rc;
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
