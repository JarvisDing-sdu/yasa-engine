static void after(void) {}

void optional_break(int n) {
    for (;;) {
        if (n) break;
        return;
    }
    after();
}

void nested_switch(int n) {
    for (;;) {
        switch (n) { case 1: break; default: return; }
        return;
    }
    after();
}

void constant_false_break(void) {
    for (;;) {
        if (0) break;
        return;
    }
    after();
}
