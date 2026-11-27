typedef void (*action)(void);
static void red(void) {}
static void green(void) {}
static void blue(void) {}
static void amber(void) {}

void nested(int a, int b) {
    action f;
    if (a) {
        if (b) f = red; else f = blue;
    } else f = green;
    f();
}

void overwritten(int a, int b) {
    action f = red;
    if (a) {
        if (b) { f = red; f = blue; } else f = green;
    } else f = amber;
    f();
}

void partial(int a, int b) {
    action f = red;
    if (a) { if (b) f = blue; } else f = amber;
    f();
}

void early(int a, int b) {
    action f = red;
    if (a) {
        if (b) { f = blue; return; } else f = green;
    } else f = amber;
    f();
}

void goto_past(int a, int b) {
    action f = red;
    if (a) {
        if (b) { f = blue; goto exit; } else f = green;
    } else f = amber;
    f();
exit:
    return;
}

void goto_call(int a, int b) {
    action f = red;
    if (a) {
        if (b) { f = blue; goto use; } else f = green;
    } else f = amber;
use:
    f();
}
