// Verified with the installed Claude CLI on Windows and macOS. Haiku rejects
// auto mode; keep the user's choice explicit instead of retrying with more access.
// `profile` is a family ("claude"/"codex"), a profile object with .family, or a legacy
// profile id ("claude", "claude1", …); account ids (acc_…) without a family are not checked
// here, the executing runner validates them with the account's family.
const idFamily = id => typeof id === 'string' && id.startsWith('claude') ? 'claude' : typeof id === 'string' && id.startsWith('codex') ? 'codex' : null;
const familyOf = profile => typeof profile === 'object' && profile ? profile.family || idFamily(profile.id) : idFamily(profile);
export const supportsAuto = (profile, model) => !(familyOf(profile) === 'claude' && /^claude-haiku-4-5(?:-|$)/.test(model || ''));
export function validateModelPermission(profile, model, permissionMode = 'auto') {
  if (permissionMode === 'auto' && !supportsAuto(profile, model)) {
    throw Object.assign(new Error('Haiku 4.5 不支持 Auto；请选择沿用 CLI 权限、Plan 或允许修改项目。'), {status:400});
  }
}
