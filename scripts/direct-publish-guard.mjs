throw new Error([
  'Direct npm publish from the repository is disabled.',
  'Publish only the exact verified .tgz produced by the release pipeline.',
  'For the one-time npm package bootstrap, download the verified release artifact and publish that tarball with maintainer 2FA.',
].join(' '))
