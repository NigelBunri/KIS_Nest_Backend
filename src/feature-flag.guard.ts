import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

export const FEATURE_FLAG_KEY = 'featureFlag'
export const FeatureFlag = (flag: string) => SetMetadata(FEATURE_FLAG_KEY, flag)

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!flag) return true
    return (process.env[flag] ?? '0') === '1'
  }
}
