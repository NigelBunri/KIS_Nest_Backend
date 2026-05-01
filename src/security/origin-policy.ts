const LOCAL_DEV_ORIGIN_PATTERNS = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/,
  /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
];

type CorsOriginValue = string | boolean | RegExp | CorsOriginValue[];

export function configuredOrigins() {
  return (process.env.ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isProductionRuntime() {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

export function isAllowedRequestOrigin(origin?: string | null) {
  if (!origin) return true;

  const allowedOrigins = configuredOrigins();
  if (allowedOrigins.includes(origin)) return true;

  if (!isProductionRuntime()) {
    return (
      allowedOrigins.length === 0 ||
      LOCAL_DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))
    );
  }

  return false;
}

export function fastifyCorsOriginDelegate(
  origin: string | undefined,
  callback: (error: Error | null, origin: CorsOriginValue) => void,
) {
  callback(null, isAllowedRequestOrigin(origin));
}

export function socketIoCorsOriginDelegate(
  origin: string | undefined,
  callback: (error: Error | null, allow: boolean) => void,
) {
  callback(null, isAllowedRequestOrigin(origin));
}
