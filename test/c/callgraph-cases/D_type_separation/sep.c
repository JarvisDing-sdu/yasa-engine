struct A { int (*f)(void); };
struct B { int (*f)(void); };
static int a_impl(void) { return 1; }
static int b_impl(void) { return 2; }
void set_a(struct A *a) { a->f = a_impl; }
void set_b(struct B *b) { b->f = b_impl; }
int call_a(struct A *a) { return a->f(); }
int call_b(struct B *b) { return b->f(); }
