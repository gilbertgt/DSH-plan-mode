const SHA_RE = /^[0-9a-f]{40}$/

function assertReleaseShas(head, main) {
  if (!SHA_RE.test(String(head)) || !SHA_RE.test(String(main))) {
    throw new Error('release blocked: invalid git SHA for release source check')
  }
}

export function assertReleaseMainTip(head, main) {
  assertReleaseShas(head, main)
  if (head !== main) throw new Error(`release blocked: tag commit ${head} is not the current origin/main tip ${main}`)
  return head
}

export function assertReleaseTagInMain(head, main, isAncestor) {
  assertReleaseShas(head, main)
  if (!isAncestor) throw new Error(`release blocked: tag commit ${head} is not contained in origin/main ${main}`)
  return head
}
