/** Web UI 路径相关配置（可通过 Vite 环境变量覆盖） */
export const USER_HOME_DIR = import.meta.env.VITE_USER_HOME ?? '/Users/lin'

/** 将拓扑记忆里的 ~ 前缀展开为本地绝对路径 */
export function expandTildePath(path: string): string {
  return path.replace(/^~(?=\/|$)/, USER_HOME_DIR)
}
