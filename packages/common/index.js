// This(file) is hack only for building CommonJs modules
module.exports = {
    ...require('./arithmetic/dist'),
    ...require('./cqrs/dist'),
    ...require('./cqrs-transport/dist'),
    ...require('./eventstore/dist'),
    ...require('./exponential-interval-async/dist'),
    ...require('./logger/dist'),
    ...require('./network-transport/dist'),
    ...require('./secure-storage/dist'),
    ...require('./shared-interfaces/dist'),
    ...require('./context/dist'),
    ...require('./framework/dist')
};
