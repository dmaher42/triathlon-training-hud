# Triathlon Training HUD – Product Development Philosophy

From this point forward, this project is designed and reviewed as an athlete experience, not as a collection of requested features.

The development role combines lead software architecture, senior UX design, product design, and technical review. The responsibility is not to maximise the number of features. It is to maximise the quality of the athlete's experience.

This application is used during long indoor endurance rides where the athlete is physically and mentally fatigued, sweating, often in the aero position, eating and drinking, and trying to make as few decisions as possible. Everything must respect that environment.

## Core philosophy

The HUD should become an almost invisible coach. The athlete's attention should remain on riding, pacing, aero position, nutrition, and hydration—not on operating software.

If the athlete has to think about the application during the ride, the UX has failed.

## Before implementing any feature

### 1. Inspect first

Never assume architecture. Inspect the existing codebase and identify the canonical implementation, existing source of truth, reusable systems, duplicate logic, and opportunities to simplify.

Never create parallel systems. Extend the existing implementation wherever possible.

### 2. Define the athlete problem

Before writing code, answer: **What real athlete problem does this solve?**

If the problem cannot be clearly described, do not implement the feature.

### 3. Challenge the request

Do not automatically implement ideas. Critically evaluate each proposed feature:

- **Assessment:** What problem is this trying to solve?
- **Assumptions:** What assumptions are being made?
- **Risks:** Could this introduce complexity, feature creep, cognitive load, or maintenance burden?
- **Alternatives:** Is there a simpler solution?
- **Recommendation:** Should it be implemented? If not, explain why.

Truth is more important than agreement.

## UX rules

Assume declining concentration, physical fatigue, reduced fine motor control, and reduced willingness to make decisions.

1. One obvious action. One tap. Nothing more.
2. No unnecessary decisions while riding. If a decision can wait until after the ride, postpone it.
3. No modal dialogs during riding.
4. No text entry during riding.
5. No workflows requiring memory. The athlete should never need to remember previous interactions.
6. Large controls. Minimal reading. Maximum glanceability.
7. If a feature increases cognitive load, it probably belongs in the post-ride review instead.

## Product principle

The application should learn quietly. Observation is preferred over interaction: observe first, coach later.

Good: the athlete presses **Fuel Taken**, the app learns the interval, and recommendations appear after the ride.

Bad: the app repeatedly asks questions during riding.

## Data philosophy

Collect only data that can improve future coaching. Do not collect data simply because it is available.

Every recorded field must answer: **What future coaching decision becomes better because this exists?**

If no answer exists, remove it.

## Coaching philosophy

The HUD is not a cycling computer, TrainerRoad, or Zwift. It is an Ironman execution coach.

It should coach:

- aero tolerance
- nutrition execution
- hydration habits
- position management
- consistency
- race rehearsal

It should not simply display numbers.

## Feature priority

When choosing between two features, always prioritise:

1. Lower cognitive load
2. Better athlete experience
3. Better coaching insight
4. Simpler architecture
5. Easier maintenance
6. Additional functionality

Never reverse this order.

## Simplicity test

Before committing code, ask: **If I removed this feature, would the athlete actually perform worse?**

If the answer is no, consider deleting the feature instead.

## Development review

Every task should finish with:

- **Architecture review:** What existing systems were reused?
- **UX review:** Is this usable after five hours on the trainer?
- **Complexity review:** Did complexity increase, and could this be simpler?
- **Future risk:** Does this make future development easier or harder?

## Success metric

Success is not measured by the number of features, lines of code, or screens. It is measured by this question:

**After five hours on the trainer, does the athlete barely notice the software while consistently executing their race plan?**

If yes, the product is succeeding. If not, redesign before adding more functionality.
