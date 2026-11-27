enum status { ok = 1 };

static int read_status(void) {
    return 1;
}

static inline enum status status(void) {
    return (enum status)read_status();
}

int run(void) {
    return status();
}
