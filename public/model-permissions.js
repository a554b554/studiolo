// Verified with the installed Claude CLI on Windows and macOS. Haiku rejects
// auto mode; keep the user's choice explicit instead of retrying with more access.
export const supportsAuto = (profileId, model) => !(profileId?.startsWith('claude') && /^claude-haiku-4-5(?:-|$)/.test(model || ''));
export function validateModelPermission(profileId, model, permissionMode = 'auto') {
  if (permissionMode === 'auto' && !supportsAuto(profileId, model)) {
    throw Object.assign(new Error('Haiku 4.5 不支持 Auto；请选择沿用 CLI 权限、Plan 或允许修改项目。'), {status:400});
  }
}
