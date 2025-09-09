import { Targets, logger } from '@cinderblock/rdt';
import { readFile } from 'node:fs/promises';
import { transform, TransformOptions } from 'esbuild';
import limit from 'promise-limit';

const serviceName = 'practice-field-management-system.service';

function posixPath(path: string) {
  return path.replace(/\\/g, '/');
}

const fileChangeLimiter = limit(3);

const host = process.env.Remote || 'steamboat';
const username = process.env.RemoteUsername || 'cameron';
const workingDirectory = process.env.RemoteDir || '/home/cameron/practice-field-management-system';

console.log(`Connecting to ${host} as ${username}...`);
console.log(`Working directory: ${workingDirectory}`);

// Control enabling of inspector on remote main process
const inspector = false;

// Marker
let forceInstallOnce = true;

const DebuggerPort = 9229;
const WebSocketServerPort = 9002;

export const targets: Targets = {};

targets[host] = {
  remote: {
    host,
    username,
    path: workingDirectory,
  },
  handler: {
    async onConnected({ rdt }) {
      const { targetName, targetConfig } = rdt;

      logger.info(`connected: ${targetName} `);

      rdt.forward
        .toRemoteTarget({ dest: { port: WebSocketServerPort }, dev: { port: 3000 } })
        .catch(e =>
          logger.error(`Failed to forward port ${WebSocketServerPort} (Websocket) to remote target: ${e.message}`),
        )
        .then(() => logger.info(`Done forwarding?`));

      // Doesn't exit
      void rdt.systemd.journal.follow(serviceName);

      if (inspector) {
        // I forget why we stop first...
        await rdt.systemd.service.stop(serviceName);

        // Doesn't exit
        void rdt.forward
          .toRemoteTarget(DebuggerPort)
          .catch(e => logger.error(`Failed to forward port ${DebuggerPort} (Debugger) to remote target: ${e.message}`))
          .then(() => logger.info(`Done forwarding???`));
      }
    },

    async onDisconnected({ rdt: { targetName, targetConfig } }) {
      logger.info(`disconnected: ${targetName}`);
    },

    async onFileChanged({ rdt, localPath }) {
      logger.info(`file changed: ${localPath}`);

      const localPathSanitized = posixPath(localPath);

      // Skipping things that don't need to be deployed
      if (localPathSanitized == 'rdt.ts') {
        logger.debug('Skipping rdt.ts');
        return;
      }
      if (localPathSanitized.startsWith('samples/')) return;
      if (localPathSanitized.startsWith('docs/')) return;
      if (localPathSanitized.startsWith('dist/')) return;
      if (localPathSanitized.startsWith('.')) return;

      // TODO: build this too!
      if (localPathSanitized.startsWith('frontend/')) return;

      logger.debug(`file changed: ${localPath}`);

      if (localPathSanitized == 'package.json') {
        const pack = await readFile('package.json').then(b => JSON.parse(b.toString()));

        logger.debug('Read package.json');
        // logger.debug(pack);

        const outFile = workingDirectory + '/package.json';

        // Don't install devDependencies on remote
        delete pack.devDependencies;

        // Don't run scripts on remote
        delete pack.scripts;

        const change = await rdt.fs.ensureFileIs(outFile, JSON.stringify(pack, null, 2));

        return change ? outFile : undefined;
      }

      if (localPathSanitized.match(/\.tsx?$/)) {
        const remotePath = workingDirectory + '/' + localPathSanitized.replace(/\.tsx?$/, '.js');

        const opts: TransformOptions = {
          loader: 'ts',
          target: 'es2022',
          format: 'esm',
          sourcemap: 'inline',
          sourcefile: localPathSanitized.replace(/^.*\//, ''),
          sourcesContent: false,
        };

        if (localPathSanitized.startsWith('src/ui/')) {
          // TODO: Bundle?
          return;

          opts.loader = 'tsx';
          opts.target = 'esnext';
        }

        const { code, map } = await transform(await readFile(localPath), opts);

        const changedFiles: string[] = [];

        await Promise.all(
          [
            [remotePath, code],
            // [remotePath + '.map', map],
          ].map(async ([path, str]) => {
            if (await fileChangeLimiter(() => rdt.fs.ensureFileIs(path, str))) changedFiles.push(path);
            logger.info(`deployed: ${path} bytes: ${str.length}`);
          }),
        );

        return { changedFiles };
      }

      // No changes
    },

    async onDeployed({ rdt, changedFiles }) {
      const { targetName, targetConfig, connection } = rdt;

      logger.info(`deployed to: ${targetName}`);

      if (changedFiles.length > 10) {
        logger.info(`  ${changedFiles.length} files changed`);
      } else {
        logger.info(`  ${changedFiles.join(', ')}`);
      }

      const tasks: Promise<unknown>[] = [];

      if (forceInstallOnce || changedFiles.includes(workingDirectory + '/package.json')) {
        tasks.push(
          rdt
            .run('npm install', [], { workingDirectory })
            .then(() => (forceInstallOnce = false))
            // For development, load the local version of the package
            .then(() => rdt.run('npm link @cinderblock/ip', [], { workingDirectory })),
        );
      }

      await Promise.all(tasks);

      // return;

      logger.info('Restarting app');

      await rdt.systemd.service.restart(serviceName);

      if (inspector) {
        const pid = await rdt.systemd.service.show(serviceName, 'MainPID');
        // Enable debugger on running process: https://nodejs.org/api/process.html#signal-events
        await rdt.run('kill -SIGUSR1', [pid], { sudo: true });
      }
    },
  },

  onDev: target => {
    logger.info(`onDev: ${target.targetName}`);

    /* Pseudo code
      - run vite dev
      - setup port forward to real backend
      */
    return async () => {
      logger.info(`onDev shutdown: ${target.targetName}`);
    };
  },

  debounceTime: 200,
};
