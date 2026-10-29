import { SetMetadata } from '@nestjs/common';

export type Role = 'provider' | 'operator';

export const REQUIRED_ROLES = 'requiredRoles';

/** A rota exige um dos papéis (realm roles do IdP). */
export const RequireRole = (...roles: Role[]) =>
  SetMetadata(REQUIRED_ROLES, roles);
