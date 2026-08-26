# Code review smell baseline

Apply these rules as design heuristics during code review. Report each finding as
a recommendation and name the smell. A documented repository standard overrides
this baseline; suppress a smell when the repository explicitly endorses the
pattern. Skip concerns already enforced by automated tooling.

## Mysterious Name

Names must reveal what a function, variable, or type does or holds. Recommend a
rename when a changed name obscures its purpose. If no precise name fits, identify
the unclear design rather than proposing a cosmetic synonym.

## Duplicated Code

Changed code should not repeat the same logic shape across hunks or files.
Recommend extracting the shared behavior and calling it from each site.

## Feature Envy

A changed method should primarily operate on the data owned by its own module or
object. When it reaches into another object's data more than its own, recommend
moving the behavior to the owner of that data.

## Data Clumps

When the same group of fields or parameters repeatedly travels together in the
change, recommend introducing a type that represents the group and passing that
type instead.

## Primitive Obsession

A primitive value should not stand in for a domain concept that has meaningful
rules or behavior. Recommend a small domain type when it would make those rules
explicit.

## Repeated Switches

The change should not repeat a switch or conditional cascade over the same kind
of value. Recommend one shared dispatch map or polymorphic behavior when repeated
dispatch is present.

## Shotgun Surgery

One logical behavior change should not require unrelated, scattered edits across
many files. Recommend gathering the behavior that changes together into one
module when the diff exposes this coupling.

## Divergent Change

A module should not be changed for several unrelated reasons in the same pull
request. Recommend separating responsibilities when one changed module combines
distinct concerns.

## Speculative Generality

Abstractions, parameters, and extension hooks must serve a current requirement.
When the linked issue or pull-request intent does not require them, recommend
removing the abstraction or inlining it until a concrete need exists.

## Message Chains

Changed code should not expose long navigation chains such as `a.b().c().d()` to
callers. Recommend hiding the traversal behind a method on the first meaningful
owner.

## Middle Man

A changed class or function should contribute behavior rather than primarily
delegate to another target. Recommend removing a needless intermediary and
calling the real target directly.

## Refused Bequest

A changed subclass or implementation should honor the contract it inherits.
When it ignores or overrides most inherited behavior, recommend replacing the
inheritance relationship with composition.
