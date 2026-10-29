import { AppModule } from './app.module';
import { bootstrap } from './bootstrap';

// Todos os papéis num processo (desenvolvimento e testes).
void bootstrap(AppModule, 'wagering', { openApi: true });
