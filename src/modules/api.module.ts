import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ProviderAuthGuard } from '../http/auth/provider-auth.guard';
import { WageringController } from '../http/wagering.controller';
import { WalletsController } from '../http/wallets.controller';
import {
  AUTH_CONFIG,
  authConfigFromEnv,
  type AuthConfig,
} from '../infrastructure/auth/auth-config';
import { JwtVerifier } from '../infrastructure/auth/jwt-verifier';
import { CoreModule } from './core.module';
import { OpsModule } from './ops.module';

/** Papel API: rotas HTTP de wallets e transações, protegidas por JWT. */
@Module({
  imports: [CoreModule, OpsModule],
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => authConfigFromEnv() },
    {
      provide: JwtVerifier,
      useFactory: (config: AuthConfig) => new JwtVerifier(config),
      inject: [AUTH_CONFIG],
    },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
  ],
})
export class ApiModule {}
