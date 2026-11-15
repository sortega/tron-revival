// On-screen steering for touch devices: three selectable modes, and the action button.
// See design/touch-controls.md.

import nipplejs from 'nipplejs';
import {
  CLASSIC_TRAVEL, DEFAULT_TOUCH_MODE, HEADING_DEADZONE, HEADING_RADIUS, TOUCH_MODES, TOUCH_MODE_LABELS,
  classicSteer, steerTowards,
} from './touchSteering';
import type { TouchMode } from './touchSteering';

const STORAGE_KEY = 'teratron-touch-mode';
const HINTS: Record<TouchMode, string> = {
  buttons: '',
  heading: 'drag towards where you want to go',
  classic: '',
};

function loadMode(): TouchMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as TouchMode | null;
    if (stored && TOUCH_MODES.includes(stored)) return stored;
  } catch { /* storage unavailable */ }
  return DEFAULT_TOUCH_MODE;
}

function saveMode(mode: TouchMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* storage unavailable */ }
}

export class TouchControls {
  private mode: TouchMode;
  private action = false;

  // `buttons`: x of every finger on the steering area
  private readonly fingers = new Map<number, number>();
  private pads: HTMLElement | null = null;

  // `heading`: the finger that steers, and the heading to turn to
  private steerTouch: number | null = null;
  private originX = 0;
  private originY = 0;
  private target: number | null = null;
  private stick: HTMLElement | null = null;
  private knob: HTMLElement | null = null;

  // `classic`
  private joystick: nipplejs.JoystickManager | null = null;
  private classicValue = 0;
  private classicSize = 0;

  constructor(
    private readonly zone: HTMLElement,
    private readonly actionButton: HTMLElement,
    private readonly modeButton: HTMLElement | null,
  ) {
    this.mode = loadMode();

    zone.addEventListener('touchstart', this.handleStart, { passive: false });
    zone.addEventListener('touchmove', this.handleMove, { passive: false });
    zone.addEventListener('touchend', this.handleEnd);
    zone.addEventListener('touchcancel', this.handleEnd);

    actionButton.addEventListener('touchstart', this.handleActionStart, { passive: false });
    actionButton.addEventListener('touchend', this.handleActionEnd);
    actionButton.addEventListener('touchcancel', this.handleActionEnd);

    modeButton?.addEventListener('click', this.handleModeClick);
    window.addEventListener('resize', this.handleResize);
    this.build();
  }

  /** What a press of the action button does right now; `enabled` false dims it. */
  showAction(label: string, enabled: boolean): void {
    if (this.actionButton.textContent !== label) this.actionButton.textContent = label;
    this.actionButton.classList.toggle('idle', !enabled);
  }

  getMode(): TouchMode {
    return this.mode;
  }

  getAction(): boolean {
    return this.action;
  }

  /**
   * Steer for this tick. `heading` is the player's current direction in degrees, or
   * null when there is nothing to steer (not playing, dead).
   */
  getSteer(heading: number | null): number {
    switch (this.mode) {
      case 'buttons': {
        const mid = this.padsCentre();
        let left = false;
        let right = false;
        for (const x of this.fingers.values()) {
          if (x < mid) left = true; else right = true;
        }
        return left === right ? 0 : left ? -1 : 1;
      }
      case 'classic':
        return this.classicValue;
      case 'heading':
        return heading === null || this.target === null ? 0 : steerTowards(heading, this.target);
    }
  }

  setMode(mode: TouchMode): void {
    this.mode = mode;
    saveMode(mode);
    this.build();
  }

  // (Re)build the steering area for the current mode
  private build(): void {
    this.joystick?.destroy();
    this.joystick = null;
    this.fingers.clear();
    this.steerTouch = null;
    this.target = null;
    this.classicValue = 0;
    this.pads = null;
    this.stick = null;
    this.knob = null;
    this.zone.innerHTML = '';
    if (this.modeButton) this.modeButton.textContent = `🕹 ${TOUCH_MODE_LABELS[this.mode]}`;

    if (HINTS[this.mode]) {
      const hint = document.createElement('div');
      hint.className = 'steer-hint';
      hint.textContent = HINTS[this.mode];
      this.zone.appendChild(hint);
    }

    if (this.mode === 'buttons') {
      this.pads = document.createElement('div');
      this.pads.className = 'steer-pads';
      this.pads.innerHTML = '<div class="steer-pad">◀</div><div class="steer-pad">▶</div>';
      this.zone.appendChild(this.pads);
    } else if (this.mode === 'heading') {
      this.stick = document.createElement('div');
      this.stick.className = 'steer-stick';
      this.stick.style.width = this.stick.style.height = `${2 * HEADING_RADIUS}px`;
      this.stick.style.display = 'none';
      this.knob = document.createElement('div');
      this.knob.className = 'steer-knob';
      this.stick.appendChild(this.knob);
      this.zone.appendChild(this.stick);
    } else if (this.mode === 'classic') {
      const joystickZone = document.createElement('div');
      joystickZone.className = 'joystick-zone';
      this.zone.appendChild(joystickZone);
      // As large as the zone the layout leaves it (the margin beside the arena)
      const size = Math.max(40, joystickZone.getBoundingClientRect().width - 10);
      this.classicSize = size;
      this.joystick = nipplejs.create({
        zone: joystickZone,
        mode: 'static',
        position: { left: '50%', top: '50%' },
        color: '#0ff',
        size,
        restOpacity: 0.7,
        lockX: true,
      });
      this.joystick.on('move', (_evt, data) => {
        const distance = data.distance ?? 0;
        const angle = data.angle?.degree ?? 0;
        // (a smaller stick has less travel: the same share of it is the same steer)
        this.classicValue = classicSteer(Math.cos((angle * Math.PI) / 180) * distance * CLASSIC_TRAVEL / (size / 2));
      });
      this.joystick.on('end', () => {
        this.classicValue = 0;
      });
    }
  }

  private padsCentre(): number {
    if (!this.pads) return 0;
    const rect = this.pads.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  private showPads(): void {
    if (!this.pads) return;
    const mid = this.padsCentre();
    let left = false;
    let right = false;
    for (const x of this.fingers.values()) {
      if (x < mid) left = true; else right = true;
    }
    this.pads.children[0]?.classList.toggle('active', left);
    this.pads.children[1]?.classList.toggle('active', right);
  }

  private showStick(x: number, y: number): void {
    if (!this.stick || !this.knob) return;
    const rect = this.zone.getBoundingClientRect();
    this.stick.style.display = 'block';
    this.stick.style.left = `${this.originX - rect.left - HEADING_RADIUS}px`;
    this.stick.style.top = `${this.originY - rect.top - HEADING_RADIUS}px`;
    this.knob.style.transform = `translate(${x - this.originX}px, ${y - this.originY}px)`;
  }

  private handleStart = (e: TouchEvent): void => {
    if (this.mode === 'classic') return; // nipplejs handles its own zone
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (this.mode === 'buttons') {
        this.fingers.set(touch.identifier, touch.clientX);
      } else if (this.steerTouch === null) {
        this.steerTouch = touch.identifier;
        this.originX = touch.clientX;
        this.originY = touch.clientY;
        this.showStick(touch.clientX, touch.clientY);
      }
    }
    this.showPads();
  };

  private handleMove = (e: TouchEvent): void => {
    if (this.mode === 'classic') return;
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (this.mode === 'buttons') {
        if (this.fingers.has(touch.identifier)) this.fingers.set(touch.identifier, touch.clientX);
      } else if (touch.identifier === this.steerTouch) {
        this.moveHeading(touch.clientX, touch.clientY);
      }
    }
    this.showPads();
  };

  private handleEnd = (e: TouchEvent): void => {
    if (this.mode === 'classic') return;
    for (const touch of Array.from(e.changedTouches)) {
      this.fingers.delete(touch.identifier);
      if (touch.identifier === this.steerTouch) {
        this.steerTouch = null;
        this.target = null; // Releasing = straight on
        if (this.stick) this.stick.style.display = 'none';
      }
    }
    this.showPads();
  };

  // The direction of the drag on screen is the heading to turn to
  private moveHeading(x: number, y: number): void {
    let dx = x - this.originX;
    let dy = y - this.originY;
    const distance = Math.hypot(dx, dy);
    if (distance > HEADING_RADIUS) {
      // The centre follows the thumb, so reversing never needs a long drag
      const excess = (distance - HEADING_RADIUS) / distance;
      this.originX += dx * excess;
      this.originY += dy * excess;
      dx = x - this.originX;
      dy = y - this.originY;
    }
    if (distance > HEADING_DEADZONE) {
      this.target = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    }
    this.showStick(x, y);
  }

  private handleActionStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.action = true;
    this.actionButton.classList.add('active');
  };

  private handleActionEnd = (): void => {
    this.action = false;
    this.actionButton.classList.remove('active');
  };

  // The stick is sized by the layout: build it again when that changes
  private handleResize = (): void => {
    if (this.mode !== 'classic') return;
    const zone = this.zone.querySelector('.joystick-zone');
    if (zone && Math.abs(zone.getBoundingClientRect().width - 10 - this.classicSize) > 1) this.build();
  };

  private handleModeClick = (): void => {
    const next = TOUCH_MODES[(TOUCH_MODES.indexOf(this.mode) + 1) % TOUCH_MODES.length]!;
    this.setMode(next);
  };

  cleanup(): void {
    this.joystick?.destroy();
    this.joystick = null;
    this.zone.removeEventListener('touchstart', this.handleStart);
    this.zone.removeEventListener('touchmove', this.handleMove);
    this.zone.removeEventListener('touchend', this.handleEnd);
    this.zone.removeEventListener('touchcancel', this.handleEnd);
    this.actionButton.removeEventListener('touchstart', this.handleActionStart);
    this.actionButton.removeEventListener('touchend', this.handleActionEnd);
    this.actionButton.removeEventListener('touchcancel', this.handleActionEnd);
    this.modeButton?.removeEventListener('click', this.handleModeClick);
    window.removeEventListener('resize', this.handleResize);
  }
}
