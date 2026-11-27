struct job { int (*run)(int); };
struct observer { void (*notify)(int); };
extern struct job shared;
extern int mode;
struct job *borrow(void);
void change(struct job *j, int n);
