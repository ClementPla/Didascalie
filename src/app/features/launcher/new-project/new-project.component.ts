import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { save } from '@tauri-apps/plugin-dialog';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FloatLabelModule } from 'primeng/floatlabel';
import { FieldsetModule } from 'primeng/fieldset';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { DividerModule } from 'primeng/divider';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { LabelledSwitchComponent } from '../../../shared/generics/labelled-switch/labelled-switch.component';
import { FolderDropZoneComponent } from '../folder-drop-zone/folder-drop-zone.component';
import { ClassificationConfigurationComponent } from '../project-configuration/classification-configuration/classification-configuration.component';
import { PixelsConfigurationComponent } from '../project-configuration/pixels-configuration/pixels-configuration.component';

import { ProjectService } from '../../../services/project/project.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { UserService } from '../../../services/users/user.service';

/** Remembers the name last typed, so it is asked once per machine. */
const OWNER_NAME_KEY = 'didascalie_user_name';

@Component({
  selector: 'app-new-project',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    InputTextModule,
    FloatLabelModule,
    FieldsetModule,
    ToggleSwitchModule,
    DividerModule,
    ProgressBarModule,
    ToastModule,
    LabelledSwitchComponent,
    FolderDropZoneComponent,
    ClassificationConfigurationComponent,
    PixelsConfigurationComponent,
  ],
  providers: [MessageService],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.scss',
})
export class NewProjectComponent implements OnInit {
  projectService = inject(ProjectService);
  labelService = inject(LabelsService);
  private router = inject(Router);
  private messageService = inject(MessageService);
  private userService = inject(UserService);

  /** Name of the project's first account, its administrator. Optional. */
  ownerName = localStorage.getItem(OWNER_NAME_KEY) ?? '';

  readonly isLoading = signal(false);
  readonly savePath = signal<string | null>(null);

  readonly nameError = signal(false);
  readonly folderError = signal(false);
  readonly savePathError = signal(false);

  readonly canStart = computed(
    () =>
      !!this.projectService.projectName() &&
      !!this.projectService.inputFolder() &&
      !!this.savePath() &&
      this.projectService.isConfigValid() &&
      !this.isLoading(),
  );

  ngOnInit(): void {
    this.nameError.set(false);
    this.folderError.set(false);
    this.savePathError.set(false);
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ── Bindings ─────────────────────────────────────────────────────────────

  get projectName(): string {
    return this.projectService.projectName();
  }
  set projectName(v: string) {
    this.projectService.setName(v);
    if (v) this.nameError.set(false);
  }

  get inputFolder(): string {
    return this.projectService.inputFolder() ?? '';
  }
  set inputFolder(v: string) {
    this.projectService.setInputFolder(v);
    if (v) this.folderError.set(false);
  }

  get inputRegex(): string {
    return this.projectService.inputRegex();
  }
  set inputRegex(v: string) {
    this.projectService.setInputRegex(v);
  }

  get videoFrameStep(): number {
    return this.projectService.videoFrameStep();
  }
  set videoFrameStep(v: number) {
    this.projectService.setVideoFrameStep(v);
  }

  get recursive(): boolean {
    return this.projectService.recursive();
  }
  set recursive(v: boolean) {
    this.projectService.setRecursive(v);
  }

  get foldersAsSequences(): boolean {
    return this.projectService.foldersAsSequences();
  }
  set foldersAsSequences(v: boolean) {
    this.projectService.setFoldersAsSequences(v);
  }

  get imagesEmbedded(): boolean {
    return this.projectService.imagesEmbedded();
  }
  set imagesEmbedded(v: boolean) {
    this.projectService.setImagesEmbedded(v);
  }

  get classificationEnabled(): boolean {
    return this.projectService.isClassification();
  }
  set classificationEnabled(v: boolean) {
    this.projectService.setClassificationEnabled(v);
  }

  get segmentationEnabled(): boolean {
    return this.projectService.isSegmentation();
  }
  set segmentationEnabled(v: boolean) {
    this.projectService.setSegmentationEnabled(v);
  }

  get instanceSegmentationEnabled(): boolean {
    return this.projectService.isInstanceSegmentation();
  }
  set instanceSegmentationEnabled(v: boolean) {
    this.projectService.setInstanceSegmentationEnabled(v);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  onFolderChange(path: string): void {
    this.inputFolder = path;
  }

  async chooseSavePath(): Promise<void> {
    const name = this.projectName?.trim() || 'untitled';
    const path = await save({
      defaultPath: `${name}.dida`,
      filters: [{ name: 'Didascalie Project', extensions: ['dida'] }],
    });
    if (path) {
      this.savePath.set(path);
      this.savePathError.set(false);
    }
  }

  async startProject(): Promise<void> {
    this.nameError.set(!this.projectName);
    this.folderError.set(!this.inputFolder);
    this.savePathError.set(!this.savePath());

    if (!this.canStart()) return;

    this.isLoading.set(true);
    try {
      await this.projectService.create(this.savePath()!);
      await this.nameOwner();
      const result = await this.projectService.scanFolder();
      this.messageService.add({
        severity: 'success',
        summary: 'Project created',
        detail: `Imported ${result.framesImported} images in ${result.sequencesCreated} sequences`,
      });
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Could not create project',
        detail: String(error),
      });
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Rename the project's first account after its creator. A failure is
   *  reported, not thrown: the project is already created. */
  private async nameOwner(): Promise<void> {
    const name = this.ownerName.trim();
    if (!name) return;
    try {
      if (!(await this.userService.ensureSession())) return;
      const me = this.userService.current()!;
      if (me.name !== name) {
        await this.userService.update(me.id, { type: 'rename', name });
      }
      localStorage.setItem(OWNER_NAME_KEY, name);
    } catch (error) {
      console.error('[new-project] could not name the first account', error);
    }
  }

  savePathDisplay(): string {
    const p = this.savePath();
    if (!p) return '';
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }
  
}
