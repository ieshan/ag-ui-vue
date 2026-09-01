import { AbstractAgent } from "@ag-ui/client";
import type { RunAgentInput, BaseEvent } from "@ag-ui/client";
import { Subject, type Observable } from "rxjs";

/**
 * A mock agent backed by an RxJS Subject for stepped event emission.
 * Tests push events into the subject to control exactly when each event fires.
 */
export class MockStepwiseAgent extends AbstractAgent {
	private subject = new Subject<BaseEvent>();
	public lastRunInput: RunAgentInput | null = null;
	public runCount = 0;

	emit(event: BaseEvent): void {
		this.subject.next(event);
	}

	emitAll(events: BaseEvent[]): void {
		events.forEach((e) => this.emit(e));
	}

	complete(): void {
		this.subject.complete();
		this.subject = new Subject<BaseEvent>();
	}

	run(input: RunAgentInput): Observable<BaseEvent> {
		this.lastRunInput = input;
		this.runCount++;
		return this.subject.asObservable();
	}
}
