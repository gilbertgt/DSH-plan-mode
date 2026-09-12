export function assertReleaseMainTip(head, main) {
  const sha = /^[0-9a-f]{40}$/
  if (!sha.test(String(head)) || !sha.test(String(main))) throw new Error('release blocked: invalid git SHA for release source check')
  if (head !== main) throw new Error(`release blocked: tag commit ${head} is not the current origin/main tip ${main}`)
  return head
}
