import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Endpoint sem autenticação (ex.: health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
