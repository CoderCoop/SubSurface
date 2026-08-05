# Subsurface: Game Design & Technical Specification

## 1. Game Overview

**Subsurface** is a level-based, 2D physics puzzle game where the player acts as a
subterranean pathfinder. The core objective is to guide a volume of viscous fluid
from a starting chamber down to a crystalline collector by carving pathways through
various reactive geological layers.

| | |
| --- | --- |
| **Genre** | Physics Puzzle / Falling Sand |
| **Target Platform** | Mobile (iOS / Android) |
| **Perspective** | 2D side-scrolling cross-section (portrait orientation) |
| **Pacing** | Relaxed but strategic; the physics simulation runs in real time, but players dictate the pace by how quickly they dig. |

## 2. Core Gameplay Mechanics

### 2.1 The Digging Interaction

- **Input:** Single-finger swipe/drag.
- **Action:** Removes terrain along the swipe path. The radius of the dig tool
  remains constant.
- **Constraint:** The player cannot add material back; digging is a destructive,
  irreversible action.

### 2.2 Fluid Dynamics (The Payload)

The fluid (e.g. teal water or luminous oil) is the game's primary physics actor.

- **Volume Conservation:** The fluid must maintain a constant volume. If a pocket
  splits, the total mass remains the same.
- **Viscosity:** The fluid is slightly viscous, preventing it from moving
  erratically and allowing it to pool satisfyingly.
- **Pressure Simulation:** Deep vertical columns of fluid exert downward pressure,
  forcing fluid quickly through narrow horizontal gaps at the bottom.

### 2.3 Geological Layers (The Obstacles)

The terrain is not just static collision data; it is made of distinct materials that
react differently to both the player's digging tool and the fluid.

#### Bedrock / Solid Rock — dark grey

- **Digging:** Impermeable and indestructible. Acts as the level boundary.

#### Clay / Silt — reddish-brown

- **Digging:** Smoothly removes material.
- **Physics:** Completely watertight. Fluid pools perfectly against it.

#### Sand / Gravel — tan

- **Digging:** Removing sand causes adjacent sand to collapse and fall due to
  gravity (angle of repose).
- **Physics:** Permeable. Fluid will slowly seep through sand, turning it into
  "wet sand" — darker colour, heavier, sticks together more.

#### Fractured Rock — jagged blue/grey

- **Digging:** Destructible, but shatters into rigid physical chunks rather than
  disappearing completely.
- **Physics:** Chunks can block narrow passages or be pushed by high fluid pressure.

## 3. Visual & Audio Direction

### 3.1 Art Style

- **Aesthetic:** Clean, vector-style cross-sections.
- **Colour Palette:** Earthy, muted tones for the soil (terracottas, ochres, slates)
  to contrast sharply with the vibrant, glowing teal of the fluid and the bright
  crystals at the goal.
- **UI:** Minimalist and technical. Readouts for "Depth," "Pressure," and
  "Collection %" use clean, sans-serif fonts resembling laboratory instruments.

### 3.2 Audio & Haptics

- **Sound Design:** ASMR-adjacent. Heavy emphasis on the crunch of digging through
  gravel, the smooth scraping of clay, and the satisfying sloshing/trickling of the
  fluid.
- **Haptics:** Continuous, subtle rumble when fluid is in rapid, pressurised motion.
  Sharp taps when digging through fractured rock.

## 4. Technical Specification & Architecture

Given the requirement for complex, interacting materials (rigid bodies, fluids, and
falling sand), a standard polygon-based physics engine will not suffice for the core
mechanic.

### 4.1 Core Simulation Engine

The game should use a hybrid simulation approach.

**Primary system: cellular automata / grid-based particle system**

- The playable area is divided into a dense 2D grid. Each pixel (or small cluster of
  pixels) acts as a particle with specific state data: material type, velocity, mass,
  wetness.
- This is the standard approach for "falling sand" games and allows for the highly
  performant simulation of thousands of interacting sand, clay, and fluid particles.

**Secondary system: rigid body physics (for fractured rock / debris)**

- A standard 2D physics engine (such as Box2D) overlays the cellular grid to handle
  large, solid chunks of rock.
- **Interaction layer:** The grid particles must exert buoyancy/pressure forces on
  the rigid bodies, and the rigid bodies must act as collision masks masking out grid
  cells.

### 4.2 State Management & Performance

- **Chunking:** The level is divided into spatial chunks. Cellular automata rules are
  only evaluated for chunks containing active (moving) particles. Static chunks
  (resting sand, untouched clay) are put to sleep to save CPU cycles.
- **Multithreading:** The particle simulation grid is highly parallelisable. State
  updates for the grid should be dispatched to worker threads or calculated via
  compute shaders on the GPU for maximum mobile performance.
- **Entity Component System (ECS):** An ECS architecture keeps the simulation
  performant, cleanly separating the data (particle states, grid positions) from the
  logic (gravity systems, fluid flow systems, input systems).

### 4.3 Level Data Structure

Levels can be stored as simple image files (e.g. PNGs) where specific hex colour
values map to initial states in the cellular grid.

| Hex value | Initial state |
| --- | --- |
| `#FF0000` | Clay |
| `#00FF00` | Sand |
| `#0000FF` | Fluid spawner |
| `#FFFFFF` | Goal / collector |

## 5. Progression & Level Design

- **Win Condition:** A specific percentage (e.g. 85%) of the initial fluid volume
  must reach the collector crystal.
- **Fail Condition:** The fluid is permanently trapped, completely absorbed by sand,
  or drains off the bottom of the screen outside the collector zone.

### Level Evolution

| Stages | Focus |
| --- | --- |
| 1–10 | Introduction to digging and clay (basic pathing) |
| 11–20 | Introduction to sand and permeability (timing puzzles, rushing fluid before it absorbs) |
| 21–30 | Introduction to fractured rock (managing debris, creating pressure valves) |
| 31+ | Multi-fluid puzzles, environmental hazards (heat sources that evaporate fluid) |
