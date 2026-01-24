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
  const message = error instanceof Error ? error.message : 'Unknown Kubernetes error';
  return createError('K8S_ERROR', message);
}

export function sshError(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : 'Unknown SSH error';
  return createError('SSH_ERROR', message);
}
