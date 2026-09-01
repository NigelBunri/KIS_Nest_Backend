import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { DjangoAuthService } from './auth/django-auth.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    // AppController's other route (callsHistory) carries @UseGuards(HttpAuthGuard),
    // which Nest resolves for the whole controller at module-compile time even
    // though this test only calls root() — so HttpAuthGuard's own dependency
    // (DjangoAuthService) needs a stub here, or compile() fails before any test runs.
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: DjangoAuthService, useValue: {} }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return status ok', () => {
      const result = appController.root();
      expect(result.status).toBe('ok');
      expect(result.service).toBe('kis-nest-backend');
    });
  });
});
