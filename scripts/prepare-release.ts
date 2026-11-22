import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const exec = promisify(execFile);
const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
  version: string;
  name: string;
  publishConfig: { access: string; registry?: string };
};
const { version } = manifest;
const tag = `v${version}`;
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Distribution releases require a stable semantic version');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag)
  throw new Error('Release tag must match package.json and the engine version');
const output = resolve(process.argv[2] ?? '.cache/release');
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'audit-release-'));
const base = `https://github.com/lmspeed/audit/releases/download/${tag}`;
const npmArchive = `lmspeed-audit-${version}.tgz`;
const githubArchive = `lmspeed-audit-github-${version}.tgz`;
const portableName = `lmspeed-audit-${version}`;
const assets = [
  npmArchive,
  githubArchive,
  `${portableName}.tar.gz`,
  `${portableName}.zip`,
];
try {
  await exec('pnpm', ['pack', '--out', join(output, npmArchive)]);
  await exec('tar', ['-xzf', join(output, npmArchive), '-C', workspace]);
  const packagePath = join(workspace, 'package/package.json');
  const githubManifest = JSON.parse(
    await readFile(packagePath, 'utf8')
  ) as typeof manifest;
  githubManifest.name = '@lmspeed/audit';
  githubManifest.publishConfig = {
    access: 'public',
    registry: 'https://npm.pkg.github.com',
  };
  await writeFile(packagePath, `${JSON.stringify(githubManifest, null, 2)}\n`);
  await exec('tar', [
    '-czf',
    join(output, githubArchive),
    '-C',
    workspace,
    'package',
  ]);

  const portable = join(workspace, 'lmspeed-audit');
  await mkdir(portable);
  await build({
    entryPoints: ['src/cli/index.ts'],
    outfile: join(portable, 'lmspeed-audit.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'eof',
  });
  await chmod(join(portable, 'lmspeed-audit.mjs'), 0o755);
  await writeFile(
    join(portable, 'lmspeed-audit.cmd'),
    '@echo off\r\nnode "%~dp0lmspeed-audit.mjs" %*\r\n'
  );
  for (const file of [
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'docs',
    'assets',
  ])
    await cp(file, join(portable, file), { recursive: true });
  await exec('tar', [
    '-czf',
    join(output, `${portableName}.tar.gz`),
    '-C',
    workspace,
    'lmspeed-audit',
  ]);
  await exec(
    'zip',
    ['-qr', join(output, `${portableName}.zip`), 'lmspeed-audit'],
    { cwd: workspace }
  );

  const hashes = new Map<string, string>();
  for (const asset of assets)
    hashes.set(
      asset,
      createHash('sha256')
        .update(await readFile(join(output, asset)))
        .digest('hex')
    );
  const formula = `class LmspeedAudit < Formula
  desc "Evidence-based LLM API and relay auditing"
  homepage "https://lmspeed.net/audit"
  url "${base}/${portableName}.tar.gz"
  sha256 "${hashes.get(`${portableName}.tar.gz`)}"
  license "Apache-2.0"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"lmspeed-audit").write_env_script libexec/"lmspeed-audit.mjs",
                                         PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/lmspeed-audit --version").strip
    probes = JSON.parse(shell_output("#{bin}/lmspeed-audit list --format json"))
    assert_includes probes, "stream_integrity"
    assert_includes probes, "tool_calling"
  end
end
`;
  await writeFile(join(output, 'lmspeed-audit.rb'), formula);
  await writeFile(
    join(output, 'lmspeed-audit.json'),
    `{
  "version": "${version}",
  "description": "Evidence-based LLM API and relay auditing",
  "homepage": "https://lmspeed.net/audit",
  "license": "Apache-2.0",
  "depends": "nodejs-lts",
  "url": "${base}/${portableName}.zip",
  "hash": "${hashes.get(`${portableName}.zip`)}",
  "extract_dir": "lmspeed-audit",
  "bin": [["lmspeed-audit.cmd", "lmspeed-audit"]],
  "checkver": {
    "github": "https://github.com/lmspeed/audit"
  },
  "autoupdate": {
    "url": "https://github.com/lmspeed/audit/releases/download/v$version/lmspeed-audit-$version.zip"
  }
}
`
  );
  for (const asset of ['lmspeed-audit.rb', 'lmspeed-audit.json']) {
    assets.push(asset);
    hashes.set(
      asset,
      createHash('sha256')
        .update(await readFile(join(output, asset)))
        .digest('hex')
    );
  }
  await writeFile(
    join(output, 'SHA256SUMS'),
    `${assets.map((asset) => `${hashes.get(asset)}  ${asset}`).join('\n')}\n`
  );
  process.stdout.write(`Release ${tag} prepared in ${output}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
