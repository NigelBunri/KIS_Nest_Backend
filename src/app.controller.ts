import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return {
      status: 'ok',
      service: 'kis-nest-backend',
      uptime_seconds: Math.round(process.uptime()),
      at: new Date().toISOString(),
    };
  }

  // The dead `/api/v1/calls/history` stub that used to live here (always
  // returning `{ results: [], count: 0 }`) is gone — real server-side call
  // history has existed in CallsController.history() (MongoDB-backed,
  // properly persisted) all along, mounted at /calls/history. The RN
  // client was pointed at this stub's path by mistake, so it always got
  // an empty result here and silently fell back to local-only AsyncStorage
  // history — meaning a fresh install/login never saw any past calls, the
  // same way messages would if only ever cached locally. Fixed client-side
  // in KIS_ReactNative_Frontend's src/network/routes/socialRoutes.ts; this
  // stub is removed rather than left in place, since a route that silently
  // absorbs requests and returns fake-empty data is exactly what let the
  // real bug hide as long as it did — better to 404 loudly than repeat that.
}
