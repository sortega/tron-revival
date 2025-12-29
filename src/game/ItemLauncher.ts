// ItemLauncher - Handles item spawning during gameplay

import type { GameItem, ItemCategory, ItemDefinition } from '../types/game';
import { AUTOMATIC_ITEMS, WEAPON_ITEMS, MAX_ITEMS_ON_FIELD, ITEM_SPAWN_MARGIN } from '../types/game';
import { PLAY_WIDTH, PLAY_HEIGHT } from './TronPlayer';

const INITIAL_ITEM_COUNT = 6;
const MIN_SPAWN_INTERVAL = 200;  // frames
const MAX_SPAWN_INTERVAL = 800;  // frames

export class ItemLauncher {
  private nextItemId = 0;
  private spawnTimer = 0;
  private nextSpawnInterval = 0;

  // Called at round start - spawns initial batch
  spawnInitialItems(
    items: GameItem[],
    getPlayerPositions: () => { x: number; y: number }[]
  ): void {
    for (let i = 0; i < INITIAL_ITEM_COUNT; i++) {
      const item = this.createItem(getPlayerPositions);
      if (item) {
        items.push(item);
      }
    }
    this.resetSpawnTimer();
  }

  // Called each frame during playing phase
  tick(
    items: GameItem[],
    getPlayerPositions: () => { x: number; y: number }[]
  ): void {
    this.spawnTimer++;

    const activeCount = items.filter(i => i.active).length;
    if (this.spawnTimer >= this.nextSpawnInterval && activeCount < MAX_ITEMS_ON_FIELD) {
      const item = this.createItem(getPlayerPositions);
      if (item) {
        items.push(item);
      }
      this.resetSpawnTimer();
    }
  }

  // Reset for new round
  reset(): void {
    this.nextItemId = 0;
    this.spawnTimer = 0;
    this.nextSpawnInterval = 0;
  }

  private resetSpawnTimer(): void {
    this.spawnTimer = 0;
    this.nextSpawnInterval = MIN_SPAWN_INTERVAL +
      Math.floor(Math.random() * (MAX_SPAWN_INTERVAL - MIN_SPAWN_INTERVAL));
  }

  private createItem(
    getPlayerPositions: () => { x: number; y: number }[]
  ): GameItem | null {
    // 40% automatic, 60% weapon
    const roll = Math.random();
    let category: ItemCategory;
    let itemDef: ItemDefinition | undefined;

    if (roll < 0.4) {
      category = 'automatic';
      itemDef = AUTOMATIC_ITEMS[Math.floor(Math.random() * AUTOMATIC_ITEMS.length)];
    } else {
      category = 'weapon';
      itemDef = WEAPON_ITEMS[Math.floor(Math.random() * WEAPON_ITEMS.length)];
    }

    if (!itemDef) return null;

    // Find valid position
    const position = this.findValidPosition(getPlayerPositions());
    if (!position) return null;

    // 10% chance to be a mystery item (shows random_item sprite, triangular collision)
    const mystery = Math.random() < 0.1;

    return {
      id: this.nextItemId++,
      sprite: itemDef.sprite,
      category,
      x: position.x,
      y: position.y,
      active: true,
      ...(mystery && { mystery }),
    };
  }

  private findValidPosition(
    playerPositions: { x: number; y: number }[]
  ): { x: number; y: number } | null {
    const margin = 20;
    const maxAttempts = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const x = margin + Math.random() * (PLAY_WIDTH - 2 * margin);
      const y = margin + Math.random() * (PLAY_HEIGHT - 2 * margin);

      let tooClose = false;
      for (const pos of playerPositions) {
        const dist = Math.sqrt((x - pos.x) ** 2 + (y - pos.y) ** 2);
        if (dist < ITEM_SPAWN_MARGIN) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        return { x: Math.floor(x), y: Math.floor(y) };
      }
    }
    return null;
  }
}
