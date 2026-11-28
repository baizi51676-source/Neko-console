/**
 * Error taxonomy.
 *
 * Before this existed, HTTP status was inferred by regex-matching the (Chinese)
 * error message, which meant a wording tweak silently changed the status code,
 * and the frontend had to parse prose to decide how to react.
 *
 * Every error the API can return now carries:
 *   - a stable machine code (`DOCKER_PORT_CONFLICT`), safe to branch on
 *   - a human message (Chinese) for display
 *   - an HTTP status chosen by category, not by string matching
 *
 * Codes are grouped by prefix so clients can handle families:
 *   AUTH_*  VALIDATION_*  NOTFOUND_*  DOCKER_*  FS_*  POWER_*  SYSTEM_*  INTERNAL_*
 */

/** @typedef {{ code: string, message: string, status: number, detail?: string }} ApiErrorShape */

const CATALOG = {
  // --- authentication / session ---
  AUTH_REQUIRED: { status: 401, message: '未登录或登录已过期' },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: '用户名或密码错误' },
  AUTH_THROTTLED: { status: 429, message: '尝试过于频繁，请稍后重试' },
  AUTH_PASSWORD_MISMATCH: { status: 403, message: '密码错误，已取消操作' },
  AUTH_MISSING_FIELDS: { status: 400, message: '请输入用户名和密码' },

  // --- request validation ---
  VALIDATION_FAILED: { status: 400, message: '请求参数不合法' },
  VALIDATION_BAD_JSON: { status: 400, message: '请求体不是合法 JSON' },
  VALIDATION_TOO_LARGE: { status: 413, message: '请求体过大' },
  VALIDATION_BAD_NAME: { status: 400, message: '名称格式不合法' },
  VALIDATION_BAD_IMAGE: { status: 400, message: '镜像名格式不合法' },
  VALIDATION_BAD_PORT: { status: 400, message: '端口号不合法' },
  VALIDATION_BAD_PATH: { status: 400, message: '路径不合法' },
  VALIDATION_BAD_ACTION: { status: 400, message: '不支持的操作' },
  VALIDATION_BAD_PID: { status: 400, message: '无效的 PID' },

  // --- resources ---
  NOTFOUND_ROUTE: { status: 404, message: '接口不存在' },
  NOTFOUND_CONTAINER: { status: 404, message: '容器不存在' },
  NOTFOUND_PROJECT: { status: 404, message: '项目不存在' },
  NOTFOUND_TEMPLATE: { status: 404, message: '应用模板不存在' },
  NOTFOUND_FILE: { status: 404, message: '文件不存在' },
  NOTFOUND_LOG: { status: 404, message: '日志文件不存在' },

  // --- docker ---
  DOCKER_UNAVAILABLE: { status: 503, message: 'Docker 不可用' },
  DOCKER_NO_PERMISSION: { status: 503, message: '当前用户无权访问 Docker' },
  DOCKER_ACTION_FAILED: { status: 502, message: 'Docker 操作执行失败' },
  DOCKER_PORT_CONFLICT: { status: 409, message: '端口已被占用' },
  DOCKER_IMAGE_UNAVAILABLE: { status: 502, message: '镜像拉取失败' },
  DOCKER_NAME_TAKEN: { status: 409, message: '容器名或项目名已存在' },
  DOCKER_COMPOSE_INVALID: { status: 400, message: 'Compose 文件校验失败' },
  DOCKER_COMPOSE_FAILED: { status: 502, message: 'Compose 启动失败' },

  // --- filesystem ---
  FS_ESCAPE: { status: 403, message: '路径超出允许范围' },
  FS_NOT_A_DIRECTORY: { status: 400, message: '目标不是目录' },
  FS_NOT_A_FILE: { status: 400, message: '目标不是文件' },
  FS_TOO_LARGE: { status: 413, message: '文件过大' },
  FS_ROOT_DELETE: { status: 403, message: '不能删除根目录' },
  FS_WRITE_FAILED: { status: 500, message: '写入失败' },
  FS_LOG_FORBIDDEN: { status: 403, message: '不允许读取该日志文件' },

  // --- power ---
  POWER_UNAVAILABLE: { status: 501, message: '该系统不支持电源操作' },
  POWER_BUSY: { status: 409, message: '有正在进行的系统任务' },
  POWER_TOKEN_INVALID: { status: 404, message: '操作已过期或不存在' },

  // --- upstream / internal ---
  SYSTEM_UNAVAILABLE: { status: 503, message: '系统信息不可用' },
  INTERNAL_ERROR: { status: 500, message: '服务器内部错误' },
};

/**
 * A coded API error.
 *
 * Carries a stable `code` so the client can branch on it, while `message` stays
 * human-readable. `detail` holds the raw cause (e.g. docker's stderr) for the
 * UI to reveal on demand.
 */
export class ApiError extends Error {
  /**
   * @param {keyof typeof CATALOG | string} code
   * @param {string} [message] Override the catalogue message
   * @param {string} [detail]
   */
  constructor(code, message, detail) {
    const entry = CATALOG[code] ?? CATALOG.INTERNAL_ERROR;
    super(message || entry.message);
    this.name = 'ApiError';
    this.code = code;
    this.status = entry.status;
    this.detail = detail;
  }

  /** Wire format; never includes a stack trace. */
  toJSON() {
    return {
      ok: false,
      error: this.message,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/**
 * Coerce anything thrown into an ApiError.
 *
 * Unknown errors become INTERNAL_ERROR and the original message is moved into
 * `detail`, so an unexpected crash does not leak internals into the top-level
 * message while still being diagnosable.
 *
 * @param {unknown} error
 * @returns {ApiError}
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError('INTERNAL_ERROR', undefined, error.message);
  }
  return new ApiError('INTERNAL_ERROR', undefined, String(error));
}

/**
 * Classify a docker/compose stderr blob into a specific code.
 *
 * Centralises the mapping so the guesswork lives in one place instead of being
 * scattered across every call site.
 *
 * @param {string} text
 * @returns {ApiError}
 */
export function classifyDockerFailure(text) {
  const raw = String(text || '');

  const portMatch = raw.match(/(?:port is already allocated|address already in use)[^\d]*(\d{2,5})?/i);
  if (portMatch) {
    const port = portMatch[1];
    return new ApiError(
      'DOCKER_PORT_CONFLICT',
      port ? `端口 ${port} 已被占用，请改用其他宿主端口` : '宿主端口已被占用，请改用其他端口',
      raw,
    );
  }
  if (/manifest unknown|pull access denied|no such image|not found: manifest/i.test(raw)) {
    return new ApiError('DOCKER_IMAGE_UNAVAILABLE', '镜像拉取失败，可能不存在或需要登录 Docker Hub', raw);
  }
  if (/permission denied|operation not permitted/i.test(raw)) {
    return new ApiError('DOCKER_NO_PERMISSION', '权限不足：确认运行用户已在 docker 组', raw);
  }
  if (/invalid reference format/i.test(raw)) {
    return new ApiError('VALIDATION_BAD_IMAGE', '镜像名格式不正确', raw);
  }
  if (/is already in use by container/i.test(raw)) {
    return new ApiError('DOCKER_NAME_TAKEN', '该容器名已被占用', raw);
  }
  if (/validating .*docker-compose|yaml: (line|unmarshal)/i.test(raw)) {
    return new ApiError('DOCKER_COMPOSE_INVALID', 'Compose 文件格式有误', raw);
  }

  const lastLine = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('time='))
    .pop();
  return new ApiError('DOCKER_COMPOSE_FAILED', lastLine ? undefined : undefined, lastLine || raw || undefined);
}

export { CATALOG as ERROR_CATALOG };
