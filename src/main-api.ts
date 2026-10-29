import { bootstrap } from './bootstrap';
import { ApiModule } from './modules/api.module';

// Imagem `api`: rotas HTTP de negócio.
void bootstrap(ApiModule, 'wagering-api', { openApi: true });
