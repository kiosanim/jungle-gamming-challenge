import { Clock } from '../../src/application/ports/clock';

/** Relógio controlado pelo teste (backoff e TTL sem esperar de verdade). */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
