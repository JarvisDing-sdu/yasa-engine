#include "hooks.h"
int invoke(int n) {
  struct job *alias = borrow();
  if(n) change(alias, n);
  else change(&shared, n+1);
  return alias->run(n);
}
void signal(struct observer *shared) {
  shared->notify(1);
}
