import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { PopoverModule } from 'primeng/popover';
import { TooltipModule } from 'primeng/tooltip';

import { api } from '../../lib/api';
import { InferenceClientService } from '../../services/inference-client.service';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Toolbar button + popover holding the application's two network settings:
 * where to find the user's Python server, and which port the application
 * itself listens on.
 */
@Component({
  selector: 'app-connection-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    InputNumberModule,
    InputTextModule,
    PopoverModule,
    TooltipModule,
  ],
  templateUrl: './connection-settings.component.html',
  styleUrl: './connection-settings.component.scss',
})
export class ConnectionSettingsComponent {
  readonly inference = inject(InferenceClientService);

  // Drafts, committed by the buttons: typing a port digit by digit must not
  // retarget the bridge at every keystroke.
  readonly host = signal('');
  readonly port = signal(0);
  readonly listenPort = signal(0);

  /** The port the running application is bound to. */
  readonly activeListenPort = signal<number | null>(null);
  /** The port it will bind to at the next launch. */
  readonly configuredListenPort = signal<number | null>(null);
  readonly listenError = signal<string | null>(null);

  readonly pythonStatus = computed(() => {
    const status = this.inference.status();
    switch (status.kind) {
      case 'connected': {
        const count = status.functions.length;
        return {
          tone: 'ok',
          text: `Connected: ${count} function${count === 1 ? '' : 's'} served`,
        };
      }
      case 'connecting':
        return { tone: 'muted', text: 'Looking for the server…' };
      case 'error':
        return {
          tone: 'warn',
          text: 'No server answers there yet. The address is saved, and the editor keeps looking for it.',
        };
      default:
        return { tone: 'muted', text: 'No server found' };
    }
  });

  readonly restartNeeded = computed(() => {
    const active = this.activeListenPort();
    const configured = this.configuredListenPort();
    return active !== null && configured !== null && active !== configured;
  });

  /** Both ends on one local port cannot work: whichever starts second fails. */
  readonly clash = computed(
    () =>
      LOCAL_HOSTS.includes(this.host().trim()) &&
      this.port() === this.listenPort(),
  );

  /** Refresh the drafts from what is in effect, each time the popover opens. */
  async onShow(): Promise<void> {
    // Keeps the status line live while the popover is open, wherever in the
    // application that is.
    this.inference.startDiscovery();
    const { host, port } = this.inference.endpoint();
    this.host.set(host);
    this.port.set(port);
    this.listenError.set(null);
    try {
      const { active, configured } = await api.getListenPort();
      this.activeListenPort.set(active);
      this.configuredListenPort.set(configured);
      this.listenPort.set(configured);
    } catch (error) {
      this.listenError.set(String(error));
    }
  }

  onHide(): void {
    this.inference.stopDiscovery();
  }

  async applyPython(): Promise<void> {
    try {
      await this.inference.connect(this.host().trim(), this.port());
    } catch {
      // Not an error to act on: the status line says the server is not there.
    }
  }

  async applyListenPort(): Promise<void> {
    this.listenError.set(null);
    try {
      await api.setListenPort(this.listenPort());
      this.configuredListenPort.set(this.listenPort());
    } catch (error) {
      this.listenError.set(String(error));
    }
  }
}
