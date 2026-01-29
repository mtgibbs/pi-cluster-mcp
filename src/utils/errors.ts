export interface ToolError {
  error: true;
  code: string;
  message: string;
}

export function createError(code: string, message: string): ToolError {
  return {
    error: true,
    code,
    message,
  };
}

export function notFoundError(resource: string): ToolError {
  return createError('NOT_FOUND', `${resource} not found`);
}

export function notAllowedError(action: string): ToolError {
  return createError('NOT_ALLOWED', `${action} is not allowed`);
}

export function validationError(message: string): ToolError {
  return createError('VALIDATION_ERROR', message);
}

export function k8sError(error: unknown): ToolError {
  // K8s client errors often have detailed info in response.body
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Check for K8s client HttpError structure
    if (err.response && typeof err.response === 'object') {
      const response = err.response as Record<string, unknown>;
      if (response.body && typeof response.body === 'object') {
        const body = response.body as Record<string, unknown>;
        if (body.message) {
          return createError('K8S_ERROR', String(body.message));
        }
      }
    }

    // Check for statusCode (common in K8s errors)
    if (err.statusCode && err.body) {
      const statusCode = String(err.statusCode);
      const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
      return createError('K8S_ERROR', `HTTP ${statusCode}: ${body}`);
    }
  }

  const message = error instanceof Error ? error.message : 'Unknown Kubernetes error';
  return createError('K8S_ERROR', message);
}

export function sshError(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : 'Unknown SSH error';
  return createError('SSH_ERROR', message);
}
