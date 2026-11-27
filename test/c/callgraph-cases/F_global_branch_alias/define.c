#include "hooks.h"
struct job shared;
int mode;
static int fallback(int x) { return x; }
static int primary(int x) { return x + 1; }
static void observed(int x) { (void)x; }

struct job *borrow(void) { return &shared; }

void change(struct job *j, int n) {
  if(n) mode = 1; else mode = 2;
  if(n > 1) {
    j->run = fallback;
    if(n > 2) j->run = primary;
  } else j->run = fallback;
}

void arm(struct observer *o) { o->notify = observed; }

int advance(int n) {
  if(n) mode = 1; else mode = 2;
  if(n > 1) n++; else n--;
  if(n > 2) n++; else n--;
  if(n > 3) n++; else n--;
  return n;
}
