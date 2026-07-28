import simpleGit, { SimpleGit } from "simple-git";
import fs  from 'fs'
const os = require ('os');
const path = require('path');




export async function gitcmd(commandLine: string, gitpath: string, publicKey:string) {
  // Create a temporary file to hold the public key
  const publicKeyPath = path.join(os.tmpdir(), 'temp_public_key');
  fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });

  // Configure the environment to use the public key
  const sshCommand = `ssh -i ${publicKeyPath}`;

   console.log ( sshCommand )

  const git = simpleGit(gitpath, {
    baseDir: process.cwd(),
    config: ['core.sshCommand=' + sshCommand]
  });

  // Get the local file path to the repository from the simple-git object
  const repoPath = await git.revparse(['--show-toplevel']);
  console.log(`Local repository path: ${repoPath}`);

  const [command, ...args] = commandLine.split(' ');

  switch (command) {
    case 'add':
      return await git.add(args);

    case 'commit':
      const messageIndex = args.indexOf('-m') + 1;
      const message = args[messageIndex];
      return await git.commit(message, args.filter((arg) => arg !== '-m' && arg !== message));

    case 'push':
      const remote = args[0];
      const branch = args[1];
      return await git.push(remote, branch);

    case 'pull':
      const pullRemote = args[0];
      const pullBranch = args[1];
      return await git.pull(pullRemote, pullBranch);

    case 'status':
      return await git.status();

    case 'checkout':
      const branchName = args[0];
      return await git.checkout(branchName);

    case 'init':
      const initOptions = args.includes('--bare') ? { '--bare': null } : {};
      return await git.init(initOptions);

    case 'clone':
      const repoClonePath = args[0];
      const localClonePath = args[1];
      return await git.clone(repoClonePath, localClonePath);

    case 'stash':
      if (args.length === 0) {
        return await git.stash();
      } else if (args[0] === 'list') {
        return await git.stashList();
      } else {
        const stashArgs = args.join(' ');
        return await git.raw(['stash', ...args]);
      }

    case 'branch':
      if (args.length === 0) {
        return await git.branch();
      } else if (args[0] === '-d' || args[0] === '--delete') {
        const branchToDelete = args[1];
        return await git.deleteLocalBranch(branchToDelete);
      } else {
        const newBranchName = args[0];
        return await git.branch([newBranchName]);
      }

    case 'remote':
      if (args.length === 0 || (args.length === 1 && args[0] === 'show')) {
        return await git.getRemotes(true);
      } else if (args.length === 2 && args[0] === 'show' && args[1] === 'origin') {
        return await git.remote(['show', 'origin']);
      } else {
        console.log(`Unsupported remote command: ${args.join(' ')}`);
        return;
      }

    default:
      console.log(`Command ${command} is not supported.`);
      return;
  }
}
