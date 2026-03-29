// src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

// ✅ Use canonical ChatModule
import { ChatModule } from './chat/chat.module';

// Optional: if PresenceModule is separate in your structure and not already inside ChatModule
// import { PresenceModule } from './chat/features/presence/presence.module';

import { UploadsModule } from './uploads/uploads.module';

// ✅ Observability + health
import { ObservabilityModule } from './observability/observability.module';
import { HealthModule } from './health/health.module';
import { BroadcastModule } from './broadcast.module';
import { FeedsModule } from './feeds.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (cfg: ConfigService) => {
        const uri = cfg.get<string>('MONGODB_URI') ?? '';
        const env = (cfg.get<string>('NODE_ENV') || 'development').toLowerCase();

        const isSrv = uri.startsWith('mongodb+srv://');
        const directConnection = !isSrv;

        const dbFromUri = (() => {
          try {
            const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
            return m?.[1];
          } catch {
            return undefined;
          }
        })();

        const dbName = dbFromUri || cfg.get<string>('MONGODB_DB') || 'kis';

        const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:*****@');
        if (env !== 'production') {
          console.log('[BOOT] MONGODB_URI =', masked);
        }

        return {
          uri,
          dbName,
          serverSelectionTimeoutMS: 8000,
          directConnection,
          tls: isSrv,
          ssl: isSrv,
          maxPoolSize: 10,
          autoIndex: env !== 'production',
          appName: 'kis-backend',
        };
      },
    }),

    // ✅ cross-cutting
    ObservabilityModule,
    HealthModule,
    BroadcastModule,
    FeedsModule,

    // ✅ core
    ChatModule,

    // ✅ uploads
    UploadsModule,
  ],
})
export class AppModule {}
