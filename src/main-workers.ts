import { bootstrap } from './bootstrap';
import { WorkersModule } from './modules/workers.module';

// Imagem `workers`: publisher da outbox e referências pendentes.
void bootstrap(WorkersModule, 'wagering-workers');
